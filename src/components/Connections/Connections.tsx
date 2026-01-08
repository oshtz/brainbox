import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import Button from '../Button/Button.tsx';
import { invoke } from '@tauri-apps/api/core';
import { aiService, PROVIDER_CONFIGS } from '../../utils/ai';
import { emit } from '@tauri-apps/api/event';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { usePrompt } from '../../contexts/PromptContext';
import {
  SparklesIcon,
  PaperAirplaneIcon,
  TrashIcon,
  ClipboardIcon,
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  LightBulbIcon,
  DocumentTextIcon,
  ArrowsPointingOutIcon,
  Cog6ToothIcon,
  XMarkIcon,
  PlusIcon,
  ChatBubbleLeftRightIcon,
  PencilIcon,
} from '@heroicons/react/24/outline';
import { SparklesIcon as SparklesSolid } from '@heroicons/react/24/solid';
import styles from './Connections.module.css';

interface ConnectionsProps {
  onOpenAISettings?: () => void;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
}

interface ChatThread {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

interface Action {
  type: 'rename' | 'move' | 'edit' | 'summarize' | 'create_vault' | 'list_notes';
  from?: string;
  to?: string;
  title?: string;
  vault?: string;
  content?: string;
  name?: string;
  password?: string;
  query?: string;
  limit?: number;
}

interface Item {
  id: string;
  vault_id: string;
  title: string;
  content: string;
  summary?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Vault {
  id: string;
  title: string;
  has_password?: boolean;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const SUGGESTION_PROMPTS = [
  { icon: LightBulbIcon, label: 'Find connections', prompt: 'What themes or patterns do you see across my recent notes?' },
  { icon: DocumentTextIcon, label: 'Summarize week', prompt: 'Give me a summary of what I captured this week' },
  { icon: ArrowsPointingOutIcon, label: 'Organize notes', prompt: 'Suggest how I could better organize my notes into vaults' },
  { icon: Cog6ToothIcon, label: 'Cleanup duplicates', prompt: 'Find any duplicate or similar notes that could be merged' },
];

// Helper to generate a title from the first user message
function generateThreadTitle(messages: Message[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user');
  if (firstUserMessage) {
    const content = firstUserMessage.content.trim();
    return content.length > 40 ? content.slice(0, 40) + '...' : content;
  }
  return 'New Chat';
}

// Serialized message/thread types (with string dates)
interface SerializedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

interface SerializedThread {
  id: string;
  title: string;
  messages: SerializedMessage[];
  createdAt: string;
  updatedAt: string;
}

// Load threads from localStorage
function loadThreads(): ChatThread[] {
  try {
    const saved = localStorage.getItem('brainyChatThreads');
    if (saved) {
      const parsed: SerializedThread[] = JSON.parse(saved);
      return parsed.map((t) => ({
        ...t,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
        messages: t.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
      }));
    }
    // Migrate from old single-thread format
    const oldHistory = localStorage.getItem('brainyChatHistory');
    if (oldHistory) {
      const oldMessages: Message[] = (JSON.parse(oldHistory) as SerializedMessage[]).map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
      if (oldMessages.length > 0) {
        const thread: ChatThread = {
          id: generateId(),
          title: generateThreadTitle(oldMessages),
          messages: oldMessages,
          createdAt: oldMessages[0]?.timestamp || new Date(),
          updatedAt: oldMessages[oldMessages.length - 1]?.timestamp || new Date(),
        };
        return [thread];
      }
    }
    return [];
  } catch {
    return [];
  }
}

export default function Connections({ onOpenAISettings }: ConnectionsProps) {
  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();
  const { getVaultKey } = useVaultPassword();

  // Chat threads state
  const [threads, setThreads] = useState<ChatThread[]>(loadThreads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => {
    const loaded = loadThreads();
    return loaded.length > 0 ? loaded[0].id : null;
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // Get current thread's messages
  const activeThread = threads.find(t => t.id === activeThreadId);
  const messages = activeThread?.messages || [];

  // Setter for messages that updates the active thread
  const setMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[])) => {
    setThreads(prevThreads => {
      return prevThreads.map(t => {
        if (t.id !== activeThreadId) return t;
        const newMessages = typeof updater === 'function' ? updater(t.messages) : updater;
        return {
          ...t,
          messages: newMessages,
          updatedAt: new Date(),
          title: t.title === 'New Chat' ? generateThreadTitle(newMessages) : t.title,
        };
      });
    });
  }, [activeThreadId]);

  const [draft, setDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Data state
  const [items, setItems] = useState<Item[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [error, setError] = useState('');

  // Actions state
  const [actionsStatus, setActionsStatus] = useState<'idle' | 'applying' | 'done' | 'ignored' | 'error'>('idle');
  const [actionsError, setActionsError] = useState('');

  // Refs
  const unlistenRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [draft, adjustTextareaHeight]);

  // Preload data
  useEffect(() => {
    preloadAll();
    return () => {
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch(_) { /* ignore */ }
      }
    };
  }, []);

  // Persist chat threads
  useEffect(() => {
    try {
      localStorage.setItem('brainyChatThreads', JSON.stringify(threads));
    } catch { /* ignore */ }
  }, [threads]);

  // Thread management functions
  function createNewThread() {
    const newThread: ChatThread = {
      id: generateId(),
      title: 'New Chat',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setThreads(prev => [newThread, ...prev]);
    setActiveThreadId(newThread.id);
    setDraft('');
  }

  function deleteThread(threadId: string) {
    setThreads(prev => prev.filter(t => t.id !== threadId));
    if (activeThreadId === threadId) {
      const remaining = threads.filter(t => t.id !== threadId);
      setActiveThreadId(remaining.length > 0 ? remaining[0].id : null);
    }
  }

  function renameThread(threadId: string, newTitle: string) {
    setThreads(prev => prev.map(t =>
      t.id === threadId ? { ...t, title: newTitle.trim() || 'Untitled' } : t
    ));
    setEditingThreadId(null);
  }

  function startEditingThread(threadId: string) {
    const thread = threads.find(t => t.id === threadId);
    if (thread) {
      setEditingThreadId(threadId);
      setEditingTitle(thread.title);
    }
  }

  async function preloadAll() {
    try {
      const vs = await invoke<any[]>('list_vaults');
      setVaults(vs.map(v => ({ id: String(v.id), title: v.name, has_password: v.has_password })));
      const allItems: Item[] = [];
      for (const v of vs) {
        try {
          const key = await getVaultKey(String(v.id), v.name, v.has_password);
          const its = await invoke<any[]>('list_vault_items', { vaultId: Number(v.id), key });
          its.forEach(it => allItems.push({
            id: String(it.id),
            vault_id: String(it.vault_id || v.id),
            title: it.title,
            content: typeof it.content === 'string' ? it.content : '',
            createdAt: new Date(it.created_at),
            updatedAt: new Date(it.updated_at),
          }));
        } catch (_) { /* ignore locked vaults */ }
      }
      setItems(allItems);
    } catch (e) {
      // ignore
    }
  }

  function buildChatSystemPrompt(): string {
    const actionSpec = `If recommending changes, propose actions as lines starting with "ACTION:".
Examples:
ACTION: rename item "Old Title" to "New Title"
ACTION: move item "Some Note" to vault "Work"
ACTION: set content of item "Quick Note" to: New content here
ACTION: summarize item "Some Note"
ACTION: create vault "New Vault"
ACTION: list notes matching "query" limit 10
Always keep normal prose separate from ACTION lines. Never execute changes yourself.`;
    const base = aiService.getSystemPrompt();
    const vaultLines = (vaults && vaults.length)
      ? `\n\nVault list:\n${vaults.map(v => `- ${v.title} (id: ${v.id})`).join('\n')}`
      : '';
    return `${base}\n\nYou are brainy, an intelligent assistant for organizing and connecting notes. Help the user discover patterns, make connections, and organize their knowledge. Be concise, helpful, and insightful.\n\n${actionSpec}${vaultLines}`;
  }

  function contextSnippet(): string {
    const recent = items
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 40);
    const lines = recent.map(it =>
      `- (${it.createdAt.toISOString().slice(0, 10)}) [${it.id}] ${it.title} — ${(it.content || '').slice(0, 140).replace(/\s+/g, ' ')}`
    );
    return `Context (recent notes):\n${lines.join('\n')}`;
  }

  async function sendChat(text?: string) {
    const messageText = (text ?? draft).trim();
    if (!messageText || chatBusy) return;

    setDraft('');
    setError('');
    setChatBusy(true);

    // Auto-create a new thread if none exists or no active thread
    let currentThreadId = activeThreadId;
    if (!currentThreadId || !threads.find(t => t.id === currentThreadId)) {
      const newThread: ChatThread = {
        id: generateId(),
        title: 'New Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setThreads(prev => [newThread, ...prev]);
      setActiveThreadId(newThread.id);
      currentThreadId = newThread.id;
    }

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    };

    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
    };

    // Use direct thread update if we just created a new thread
    if (currentThreadId !== activeThreadId) {
      setThreads(prev => prev.map(t => {
        if (t.id !== currentThreadId) return t;
        return {
          ...t,
          messages: [userMessage, assistantMessage],
          updatedAt: new Date(),
          title: generateThreadTitle([userMessage]),
        };
      }));
    } else {
      setMessages(prev => [...prev, userMessage, assistantMessage]);
    }

    try {
      if (!items.length) await preloadAll();
      const sys = buildChatSystemPrompt();
      const prompt = `${contextSnippet()}\n\nUser: ${messageText}\nAssistant:`;

      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch(_) { /* ignore */ }
      }

      unlistenRef.current = await aiService.streamGenerate(
        { prompt, system: sys },
        {
          onToken: (t: string) => setMessages(prev => {
            const next = [...prev];
            const lastIdx = next.length - 1;
            if (next[lastIdx] && next[lastIdx].role === 'assistant') {
              next[lastIdx] = {
                ...next[lastIdx],
                content: next[lastIdx].content + t,
              };
            }
            return next;
          }),
          onDone: () => {
            setMessages(prev => {
              const next = [...prev];
              const lastIdx = next.length - 1;
              if (next[lastIdx] && next[lastIdx].role === 'assistant') {
                next[lastIdx] = { ...next[lastIdx], isStreaming: false };
              }
              return next;
            });
            setChatBusy(false);
          }
        }
      );
    } catch (e) {
      setError(String(e));
      setChatBusy(false);
    }
  }

  // Parse proposed actions from the last assistant message
  const proposedActions = useMemo<Action[]>(() => {
    const last = [...messages].reverse().find(m => m.role === 'assistant' && !m.isStreaming);
    if (!last) return [];
    const lines = last.content.split(/\r?\n/).map(s => s.trim());
    const acts: Action[] = [];
    for (const line of lines) {
      if (!line.toUpperCase().startsWith('ACTION:')) continue;
      const m1 = line.match(/^ACTION:\s*rename item\s+"(.+?)"\s+to\s+"(.+?)"/i);
      if (m1) { acts.push({ type: 'rename', from: m1[1], to: m1[2] }); continue; }
      const m2 = line.match(/^ACTION:\s*move item\s+"(.+?)"\s+to vault\s+"(.+?)"/i);
      if (m2) { acts.push({ type: 'move', title: m2[1], vault: m2[2] }); continue; }
      const m3 = line.match(/^ACTION:\s*set content of item\s+"(.+?)"\s+to:\s*(.+)$/i);
      if (m3) { acts.push({ type: 'edit', title: m3[1], content: m3[2] }); continue; }
      const m4 = line.match(/^ACTION:\s*summarize item\s+"(.+?)"/i);
      if (m4) { acts.push({ type: 'summarize', title: m4[1] }); continue; }
      const m5 = line.match(/^ACTION:\s*create vault\s+"(.+?)"(?:\s+password\s+"(.+?)")?/i);
      if (m5) { acts.push({ type: 'create_vault', name: m5[1], password: m5[2] }); continue; }
      const m6 = line.match(/^ACTION:\s*(?:list|fetch) notes(?:\s+matching\s+"(.+?)")?(?:\s+limit\s+(\d+))?/i);
      if (m6) { acts.push({ type: 'list_notes', query: m6[1] || '', limit: m6[2] ? parseInt(m6[2]) : 10 }); continue; }
    }
    return acts;
  }, [messages]);

  // Reset actions status when new actions are proposed
  useEffect(() => {
    setActionsStatus('idle');
    setActionsError('');
  }, [proposedActions]);

  function findItemByTitle(title: string): Item | undefined {
    const exact = items.filter(i => i.title === title);
    if (exact.length >= 1) return exact[0];
    const lower = title.toLowerCase();
    return items.find(i => i.title.toLowerCase().includes(lower));
  }

  async function executeActions() {
    if (!proposedActions.length) return;
    const confirmed = await confirmDialog({
      title: `Apply ${proposedActions.length} change(s)?`,
      message: 'brainy proposed actions will modify your notes/vaults.',
      confirmLabel: 'Apply',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

    setActionsStatus('applying');
    setActionsError('');
    let hadError = false;

    for (const act of proposedActions) {
      try {
        if (act.type === 'rename' && act.from && act.to) {
          const it = findItemByTitle(act.from);
          if (!it) throw new Error(`Item not found: ${act.from}`);
          await invoke('update_vault_item_title', { itemId: Number(it.id), title: act.to });
          setItems(prev => prev.map(p => p.id === it.id ? { ...p, title: act.to! } : p));
          try { await emit('items-changed', { type: 'rename', itemId: String(it.id), vaultId: String(it.vault_id || '') }); } catch { /* ignore */ }
        } else if (act.type === 'move' && act.title && act.vault) {
          const it = findItemByTitle(act.title);
          if (!it) throw new Error(`Item not found: ${act.title}`);
          const v = vaults.find(v => v.title === act.vault) || vaults.find(v => v.title.toLowerCase() === act.vault!.toLowerCase());
          if (!v) throw new Error(`Vault not found: ${act.vault}`);
          const from = String(it.vault_id || '');
          await invoke('move_vault_item', { itemId: Number(it.id), targetVaultId: Number(v.id) });
          setItems(prev => prev.map(p => p.id === it.id ? { ...p, vault_id: v.id } : p));
          try { await emit('items-changed', { type: 'move', itemId: String(it.id), fromVaultId: from, toVaultId: String(v.id) }); } catch { /* ignore */ }
        } else if (act.type === 'edit' && act.title && act.content) {
          const it = findItemByTitle(act.title);
          if (!it) throw new Error(`Item not found: ${act.title}`);
          const vault = vaults.find(v => v.id === it.vault_id);
          const key = await getVaultKey(it.vault_id, vault?.title, vault?.has_password);
          await invoke('update_vault_item_content', { itemId: Number(it.id), content: act.content, key });
          setItems(prev => prev.map(p => p.id === it.id ? { ...p, content: act.content! } : p));
          try { await emit('items-changed', { type: 'edit', itemId: String(it.id), vaultId: String(it.vault_id || '') }); } catch { /* ignore */ }
        } else if (act.type === 'summarize' && act.title) {
          const it = findItemByTitle(act.title);
          if (!it) throw new Error(`Item not found: ${act.title}`);
          const header = it.title ? `Title: ${it.title}\n` : '';
          const body = it.content ? `Content (truncated):\n${String(it.content).slice(0, 4000)}` : '';
          let full = '';
          await aiService.streamGenerate(
            { prompt: `${header}${body}\n\nTask: Summarize succinctly in plain text.` },
            {
              onToken: (t: string) => { full += t; },
              onDone: async () => {
                try { await invoke('update_vault_item_summary', { itemId: Number(it.id), summary: full.trim() }); } catch { /* ignore */ }
                setItems(prev => prev.map(p => p.id === it.id ? { ...p, summary: full.trim() } : p));
                try { await emit('items-changed', { type: 'summarize', itemId: String(it.id), vaultId: String(it.vault_id || '') }); } catch { /* ignore */ }
              }
            }
          );
        } else if (act.type === 'create_vault') {
          const name = act.name || (await promptDialog({
            title: 'Create vault',
            label: 'Vault name',
            placeholder: 'e.g. Research',
            confirmLabel: 'Create',
            required: true
          })) || '';
          if (!name.trim()) throw new Error('Vault name required');
          const pw = (act.password !== undefined) ? act.password : ((await promptDialog({
            title: 'Set vault password',
            message: 'Optional. Leave it blank if you do not want a password.',
            label: 'Vault password',
            inputType: 'password',
            autoComplete: 'new-password',
            confirmLabel: 'Continue',
            cancelLabel: 'Skip'
          })) || '');
          await invoke('create_vault', { name: name.trim(), password: pw });
          try { await emit('vaults-changed'); } catch { /* ignore */ }
          try {
            const vs = await invoke<any[]>('list_vaults');
            setVaults(vs.map(v => ({ id: String(v.id), title: v.name })));
          } catch { /* ignore */ }
        } else if (act.type === 'list_notes') {
          const q = act.query && act.query.trim() ? act.query : '';
          const res = q ? await invoke<any[]>('search', { query: q, limit: act.limit || 10 }) : [];
          const lines = (res || []).map((r) => `- [${r.id}] ${r.title} (${(r && r.metadata && r.metadata.item_type) ? r.metadata.item_type : 'note'})`);
          const resultMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: lines.length ? `Relevant notes:\n${lines.join('\n')}` : 'No relevant notes found.',
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, resultMessage]);
        }
      } catch (e) {
        hadError = true;
        setActionsError(String(e));
      }
    }
    setActionsStatus(hadError ? 'error' : 'done');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  }

  async function copyMessage(content: string, id: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch { /* ignore */ }
  }

  async function regenerateLastResponse() {
    if (chatBusy) return;
    // Find the last user message
    const lastUserIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIdx === -1) return;
    const userIdx = messages.length - 1 - lastUserIdx;
    const userMessage = messages[userIdx];
    // Remove all messages after (and including) the last user message
    setMessages(prev => prev.slice(0, userIdx));
    // Resend
    setTimeout(() => sendChat(userMessage.content), 100);
  }

  function clearChat() {
    if (unlistenRef.current) {
      try { unlistenRef.current(); } catch(_) { /* ignore */ }
    }
    setMessages([]);
    try { localStorage.setItem('brainyChatHistory', '[]'); } catch { /* ignore */ }
  }

  function deleteMessage(id: string) {
    setMessages(prev => prev.filter(m => m.id !== id));
  }

  function renderMessageContent(content: string): React.ReactNode {
    // Filter out ACTION lines for display
    const filteredContent = content
      .split(/\r?\n/)
      .filter(line => !/^ACTION\s*:/i.test(line.trim()))
      .join('\n')
      .trim();
    
    return (
      <div className={styles.markdown}>
        <ReactMarkdown
          components={{
            // Open links in new tab
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
            // Style code blocks
            code: ({ className, children, ...props }) => {
              const isInline = !className;
              return isInline ? (
                <code className={styles.inlineCode} {...props}>{children}</code>
              ) : (
                <code className={className} {...props}>{children}</code>
              );
            },
          }}
        >
          {filteredContent}
        </ReactMarkdown>
      </div>
    );
  }

  // Check if we should show actions for a specific message
  function shouldShowActions(message: Message, index: number): boolean {
    if (message.role !== 'assistant' || message.isStreaming) return false;
    // Only show for the last non-streaming assistant message
    const lastAssistantIdx = messages.map((m, i) => ({ ...m, i }))
      .filter(m => m.role === 'assistant' && !m.isStreaming)
      .pop()?.i;
    return index === lastAssistantIdx && proposedActions.length > 0;
  }

  const hasMessages = messages.length > 0;

  return (
    <div className={styles.container}>
      <div className={styles.mainLayout}>
        {/* Threads Sidebar */}
        <div className={`${styles.threadsSidebar} ${!sidebarOpen ? styles.threadsSidebarCollapsed : ''}`}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarTitle}>
              <ChatBubbleLeftRightIcon className={styles.sidebarTitleIcon} />
              <span>Chats</span>
            </div>
            <button
              className={styles.newThreadBtn}
              onClick={createNewThread}
              title="New chat"
            >
              <PlusIcon className={styles.iconTiny} />
            </button>
          </div>
          <div className={styles.threadsList}>
            {threads.length === 0 ? (
              <div className={styles.emptyThreads}>
                <ChatBubbleLeftRightIcon className={styles.emptyThreadsIcon} />
                <p className={styles.emptyThreadsText}>No chats yet</p>
              </div>
            ) : (
              threads.map(thread => (
                <div
                  key={thread.id}
                  className={`${styles.threadItem} ${thread.id === activeThreadId ? styles.threadItemActive : ''}`}
                  onClick={() => setActiveThreadId(thread.id)}
                >
                  {editingThreadId === thread.id ? (
                    <input
                      className={styles.threadEditInput}
                      value={editingTitle}
                      onChange={e => setEditingTitle(e.target.value)}
                      onBlur={() => renameThread(thread.id, editingTitle)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') renameThread(thread.id, editingTitle);
                        if (e.key === 'Escape') setEditingThreadId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <>
                      <div className={styles.threadItemContent}>
                        <div className={styles.threadItemTitle}>{thread.title}</div>
                        <div className={styles.threadItemDate}>
                          {thread.updatedAt.toLocaleDateString()}
                        </div>
                      </div>
                      <div className={styles.threadItemActions}>
                        <button
                          className={styles.threadActionBtn}
                          onClick={e => { e.stopPropagation(); startEditingThread(thread.id); }}
                          title="Rename"
                        >
                          <PencilIcon className={styles.iconTiny} />
                        </button>
                        <button
                          className={`${styles.threadActionBtn} ${styles.threadActionBtnDanger}`}
                          onClick={e => { e.stopPropagation(); deleteThread(thread.id); }}
                          title="Delete"
                        >
                          <TrashIcon className={styles.iconTiny} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Chat Content */}
        <div className={styles.chatContent}>
          <div className={styles.chatWrapper}>
            {/* Header */}
            <div className={styles.header}>
              <div className={styles.headerLeft}>
                <button
                  className={styles.toggleSidebarBtn}
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  title={sidebarOpen ? 'Hide chats' : 'Show chats'}
                >
                  <ChatBubbleLeftRightIcon className={styles.iconSmall} />
                </button>
                <div className={styles.avatarLarge}>
                  <SparklesSolid className={styles.avatarIconLarge} />
                </div>
                <div>
                  <h1 className={styles.title}>brainy</h1>
                  <p className={styles.subtitle}>
                    Powered by {PROVIDER_CONFIGS[aiService.getActiveProviderType()]?.name || 'AI'}
                    {aiService.getProviderSettings(aiService.getActiveProviderType())?.model && (
                      <span className={styles.modelBadge}>
                        {aiService.getProviderSettings(aiService.getActiveProviderType())?.model}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className={styles.headerActions}>
                {onOpenAISettings && (
                  <button
                    className={styles.iconButton}
                    onClick={onOpenAISettings}
                    title="AI Settings"
                  >
                    <Cog6ToothIcon className={styles.iconSmall} />
                  </button>
                )}
                {hasMessages && (
                  <button
                    className={styles.iconButton}
                    onClick={clearChat}
                    title="Clear chat"
                  >
                    <TrashIcon className={styles.iconSmall} />
                  </button>
                )}
              </div>
            </div>

        {/* Messages */}
        <div className={styles.messagesContainer} ref={chatContainerRef}>
          {!hasMessages ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <SparklesSolid className={styles.emptyIconInner} />
              </div>
              <h2 className={styles.emptyTitle}>Start a conversation</h2>
              <p className={styles.emptySubtitle}>
                Ask brainy to find patterns, organize notes, or discover connections in your knowledge base.
              </p>
              <div className={styles.suggestions}>
                {SUGGESTION_PROMPTS.map((suggestion, i) => (
                  <button
                    key={i}
                    className={styles.suggestionChip}
                    onClick={() => sendChat(suggestion.prompt)}
                  >
                    <suggestion.icon className={styles.suggestionIcon} />
                    <span>{suggestion.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.messagesList}>
              {messages.map((message, index) => (
                <div
                  key={message.id}
                  className={`${styles.messageRow} ${message.role === 'user' ? styles.messageRowUser : styles.messageRowAssistant}`}
                >
                  {message.role === 'assistant' && (
                    <div className={styles.avatar}>
                      <SparklesIcon className={styles.avatarIcon} />
                    </div>
                  )}
                  <div className={`${styles.messageBubble} ${message.role === 'user' ? styles.userBubble : styles.assistantBubble}`}>
                    <div className={styles.messageContent}>
                      {message.isStreaming && !message.content ? (
                        <div className={styles.typingIndicator}>
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      ) : (
                        <>
                          {renderMessageContent(message.content)}
                          {message.isStreaming && <span className={styles.cursor}>|</span>}
                        </>
                      )}
                    </div>

                    {/* Actions panel */}
                    {shouldShowActions(message, index) && (
                      <div className={styles.actionsPanel}>
                        <div className={styles.actionsPanelHeader}>
                          <ChevronDownIcon className={styles.actionsIcon} />
                          <span>Proposed changes ({proposedActions.length})</span>
                        </div>
                        <ul className={styles.actionsList}>
                          {proposedActions.map((a, idx) => (
                            <li key={idx} className={styles.actionItem}>
                              {a.type === 'rename' && <span>Rename "{a.from}" → "{a.to}"</span>}
                              {a.type === 'move' && <span>Move "{a.title}" → vault "{a.vault}"</span>}
                              {a.type === 'edit' && <span>Edit "{a.title}" content</span>}
                              {a.type === 'summarize' && <span>Summarize "{a.title}"</span>}
                              {a.type === 'create_vault' && <span>Create vault "{a.name}"</span>}
                              {a.type === 'list_notes' && <span>List notes{a.query ? ` matching "${a.query}"` : ''}</span>}
                            </li>
                          ))}
                        </ul>
                        <div className={styles.actionsButtons}>
                          {(actionsStatus === 'idle' || actionsStatus === 'error') && (
                            <>
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={executeActions}
                              >
                                {actionsStatus === 'error' ? 'Retry' : 'Apply changes'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setActionsStatus('ignored')}
                              >
                                Ignore
                              </Button>
                            </>
                          )}
                          {actionsStatus === 'applying' && (
                            <span className={styles.statusApplying}>Applying...</span>
                          )}
                          {actionsStatus === 'done' && (
                            <span className={styles.statusDone}>
                              <CheckIcon className={styles.statusIcon} />
                              Applied
                            </span>
                          )}
                          {actionsStatus === 'ignored' && (
                            <span className={styles.statusIgnored}>Ignored</span>
                          )}
                        </div>
                        {actionsStatus === 'error' && actionsError && (
                          <div className={styles.actionsError}>{actionsError}</div>
                        )}
                      </div>
                    )}

                    {/* Message footer */}
                    <div className={styles.messageFooter}>
                      <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
                      <div className={styles.messageActions}>
                        <button
                          className={styles.messageActionBtn}
                          onClick={() => copyMessage(message.content, message.id)}
                          title="Copy"
                        >
                          {copiedId === message.id ? (
                            <CheckIcon className={styles.iconTiny} />
                          ) : (
                            <ClipboardIcon className={styles.iconTiny} />
                          )}
                        </button>
                        {message.role === 'assistant' && !message.isStreaming && index === messages.length - 1 && (
                          <button
                            className={styles.messageActionBtn}
                            onClick={regenerateLastResponse}
                            title="Regenerate"
                          >
                            <ArrowPathIcon className={styles.iconTiny} />
                          </button>
                        )}
                        <button
                          className={styles.messageActionBtn}
                          onClick={() => deleteMessage(message.id)}
                          title="Delete"
                        >
                          <XMarkIcon className={styles.iconTiny} />
                        </button>
                      </div>
                    </div>
                  </div>
                  {message.role === 'user' && <div className={styles.avatarSpacer} />}
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button onClick={() => setError('')} className={styles.errorClose}>
              <XMarkIcon className={styles.iconSmall} />
            </button>
          </div>
        )}

        {/* Input area */}
        <div className={styles.inputArea}>
          <div className={styles.inputWrapper}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask brainy anything..."
              rows={1}
              disabled={chatBusy}
            />
            <button
              className={`${styles.sendButton} ${draft.trim() && !chatBusy ? styles.sendButtonActive : ''}`}
              onClick={() => sendChat()}
              disabled={chatBusy || !draft.trim()}
            >
              <PaperAirplaneIcon className={styles.sendIcon} />
            </button>
          </div>
          <p className={styles.inputHint}>
            Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
          </p>
        </div>
      </div>
        </div>{/* chatContent */}
      </div>{/* mainLayout */}
    </div>
  );
}
