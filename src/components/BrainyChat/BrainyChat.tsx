/**
 * brainy Chat Component
 *
 * Interactive chat interface for brainy AI assistant with tool calling support.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  XMarkIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ChatBubbleLeftRightIcon,
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  Cog6ToothIcon,
  ArrowsPointingInIcon,
} from '@heroicons/react/24/outline';
import styles from './BrainyChat.module.css';
import { aiService } from '../../utils/ai/service';
import { ToolExecutor, VaultInfo } from '../../utils/ai/toolExecutor';
import { runAgentLoop, AgentCallbacks, AGENT_SYSTEM_PROMPT } from '../../utils/ai/agentLoop';
import { ToolCall } from '../../utils/ai/tools';
import { Message } from '../../utils/ai/types';
import { useVaultPassword } from '../../contexts/VaultPasswordContext';
import { usePrompt } from '../../contexts/PromptContext';
import { useConfirm } from '../../contexts/ConfirmContext';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCall?: ToolCall;
  toolStatus?: 'running' | 'success' | 'error';
  timestamp: Date;
}

interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  summary?: string;
  summaryUpdatedAt?: Date;
  summaryUpTo?: number;
}

interface Props {
  vaults: VaultInfo[];
  currentVaultId?: string;
  variant?: 'panel' | 'page';
  onClose: () => void;
  onDataChange?: () => void;
  onOpenSettings?: () => void;
}

const SUGGESTIONS = [
  'List all my vaults',
  'Search for notes about projects',
  'Create a new note',
  'Summarize this item',
];

const THREADS_STORAGE_KEY = 'brainyChatThreads';
const HISTORY_STORAGE_KEY = 'brainyChatHistory';
const ACTIVE_THREAD_KEY = 'brainyChatActiveThreadId';
const MAX_HISTORY_MESSAGES = 12;
const COMPACT_KEEP_RECENT = 8;
const COMPACT_TRIGGER_MESSAGES = 18;
const COMPACT_MIN_UNSUMMARIZED = 6;

const generateId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const formatMessageTime = (date: Date) =>
  date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const generateThreadTitle = (messages: ChatMessage[]) => {
  const firstUserMessage = messages.find((m) => m.role === 'user');
  if (firstUserMessage) {
    const content = firstUserMessage.content.trim();
    return content.length > 40 ? `${content.slice(0, 40)}...` : content;
  }
  return 'New Chat';
};

const BrainyChat: React.FC<Props> = ({ vaults, currentVaultId, variant = 'panel', onClose, onDataChange, onOpenSettings }) => {
  const { getVaultKey } = useVaultPassword();
  const promptDialog = usePrompt();
  const confirmDialog = useConfirm();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;
  const messages = activeThread?.messages || [];

  const updateThreadMessages = useCallback(
    (threadId: string, updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      setThreads((prevThreads) =>
        prevThreads.map((thread) => {
          if (thread.id !== threadId) return thread;
          const newMessages = typeof updater === 'function' ? updater(thread.messages) : updater;
          return {
            ...thread,
            messages: newMessages,
            updatedAt: new Date(),
            title: thread.title === 'New Chat' ? generateThreadTitle(newMessages) : thread.title,
          };
        })
      );
    },
    []
  );

  const createNewThread = useCallback(() => {
    const newThread: ChatThread = {
      id: generateId(),
      title: 'New Chat',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setThreads((prev) => [newThread, ...prev]);
    setActiveThreadId(newThread.id);
    setInput('');
  }, []);

  const renameActiveThread = useCallback(async () => {
    if (!activeThread) return;
    const newTitle = await promptDialog({
      title: 'Rename chat',
      label: 'Chat name',
      defaultValue: activeThread.title,
      confirmLabel: 'Rename',
    });
    if (newTitle === null) return;
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === activeThread.id
          ? { ...thread, title: trimmed, updatedAt: new Date() }
          : thread
      )
    );
  }, [activeThread, promptDialog]);

  const deleteActiveThread = useCallback(async () => {
    if (!activeThread) return;
    const confirmed = await confirmDialog({
      title: 'Delete chat?',
      message: 'This will remove the selected chat thread.',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const remaining = threads.filter((thread) => thread.id !== activeThread.id);
    setThreads(remaining);
    setActiveThreadId((prev) => {
      if (prev !== activeThread.id) return prev;
      return remaining[0]?.id || null;
    });
  }, [activeThread, confirmDialog, threads]);

  const compactThread = useCallback(async (threadId: string) => {
    if (isCompacting || !aiService.isConfigured()) return;
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;

    const nonToolMessages = thread.messages.filter((msg) => msg.role !== 'tool');
    if (nonToolMessages.length <= COMPACT_KEEP_RECENT) return;

    const summarizeUpTo = nonToolMessages.length - COMPACT_KEEP_RECENT;
    const alreadySummarized = Math.min(thread.summaryUpTo ?? 0, summarizeUpTo);
    const newMessages = nonToolMessages.slice(alreadySummarized, summarizeUpTo);
    if (newMessages.length === 0) return;

    const compactLines = newMessages.map((msg) => {
      const label = msg.role === 'user' ? 'User' : 'Assistant';
      return `${label}: ${msg.content}`;
    });
    const prompt = [
      thread.summary ? `Existing summary:\n${thread.summary}` : '',
      `New messages to compact:\n${compactLines.join('\n')}`,
      'Update the memory summary to preserve key facts, decisions, user preferences, created items/vaults, and pending tasks.',
      'Keep it concise and plain text. Avoid markdown, headings, or numbered lists.',
    ]
      .filter(Boolean)
      .join('\n\n');

    setIsCompacting(true);
    try {
      const summary = await aiService.generate({
        prompt,
        system: 'You are a memory compactor for a chat assistant. Output a concise, plain-text summary for continuity.',
      });
      setThreads((prev) =>
        prev.map((item) =>
          item.id === threadId
            ? {
                ...item,
                summary: summary.trim(),
                summaryUpdatedAt: new Date(),
                summaryUpTo: summarizeUpTo,
              }
            : item
        )
      );
    } catch (error) {
      console.error('Failed to compact chat thread:', error);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, threads]);

  // Check if AI is configured
  useEffect(() => {
    setIsConfigured(aiService.isConfigured());
  }, []);

  // Chat is intentionally session-only. Offer to remove plaintext history left
  // by older releases, but never delete it without the user's approval.
  useEffect(() => {
    const hasLegacyHistory = [THREADS_STORAGE_KEY, HISTORY_STORAGE_KEY, ACTIVE_THREAD_KEY]
      .some((key) => localStorage.getItem(key) !== null);
    if (!hasLegacyHistory) return;
    void confirmDialog({
      title: 'Remove old local chat history?',
      message: 'Older brainbox versions stored Brainy chats unencrypted. New chats are session-only. Remove the old plaintext history now?',
      confirmLabel: 'Remove history',
    }).then((confirmed) => {
      if (!confirmed) return;
      localStorage.removeItem(THREADS_STORAGE_KEY);
      localStorage.removeItem(HISTORY_STORAGE_KEY);
      localStorage.removeItem(ACTIVE_THREAD_KEY);
    });
  }, [confirmDialog]);

  // Ensure active thread exists
  useEffect(() => {
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(threads[0]?.id || null);
      return;
    }
    if (!activeThreadId && threads.length > 0) {
      setActiveThreadId(threads[0].id);
    }
  }, [activeThreadId, threads]);

  // Auto-compact long threads
  useEffect(() => {
    if (!activeThread || isProcessing || isCompacting) return;
    if (!aiService.isConfigured()) return;
    const nonToolMessages = activeThread.messages.filter((msg) => msg.role !== 'tool');
    if (nonToolMessages.length < COMPACT_TRIGGER_MESSAGES) return;
    const summarizeUpTo = nonToolMessages.length - COMPACT_KEEP_RECENT;
    const alreadySummarized = Math.min(activeThread.summaryUpTo ?? 0, summarizeUpTo);
    const unsummarized = summarizeUpTo - alreadySummarized;
    if (unsummarized >= COMPACT_MIN_UNSUMMARIZED) {
      compactThread(activeThread.id);
    }
  }, [activeThread, isProcessing, isCompacting, compactThread]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeThreadId]);

  const getVaultInfo = useCallback((vaultId: string): VaultInfo | undefined => {
    return vaults.find((v) => v.id === vaultId);
  }, [vaults]);

  const confirmAction = useCallback(async (message: string): Promise<boolean> => {
    const result = await promptDialog({
      title: 'Confirm Action',
      message,
      label: 'Type "yes" to confirm',
      confirmLabel: 'Confirm',
    });
    return result?.toLowerCase() === 'yes';
  }, [promptDialog]);

  const handleSend = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isProcessing) return;

    let threadId = activeThreadId;
    if (!threadId || !threads.find((thread) => thread.id === threadId)) {
      const newThread: ChatThread = {
        id: generateId(),
        title: 'New Chat',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      setThreads((prev) => [newThread, ...prev]);
      setActiveThreadId(newThread.id);
      threadId = newThread.id;
    }

    const threadForHistory = threads.find((thread) => thread.id === threadId);
    const historyMessages = threadForHistory?.messages || [];
    const nonToolMessages = historyMessages.filter(
      (msg): msg is ChatMessage & { role: 'user' | 'assistant' } => msg.role !== 'tool'
    );
    const summaryUpTo = Math.min(threadForHistory?.summaryUpTo ?? 0, nonToolMessages.length);
    const remainingMessages = nonToolMessages.slice(summaryUpTo);
    const recentMessages = remainingMessages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((msg) => ({ role: msg.role, content: msg.content }));
    const summaryMessage: Message[] = threadForHistory?.summary
      ? [{ role: 'assistant', content: `Memory summary: ${threadForHistory.summary}` }]
      : [];
    const conversationHistory: Message[] = [...summaryMessage, ...recentMessages];
    const currentVault = currentVaultId
      ? vaults.find((v) => v.id === currentVaultId)
      : undefined;
    const vaultList = vaults.length
      ? `Vaults:\n${vaults.map((v) => `- ${v.title} (id: ${v.id})`).join('\n')}`
      : '';
    const currentVaultLine = currentVault
      ? `Current vault: ${currentVault.title} (id: ${currentVault.id})`
      : '';
    const systemPrompt = [
      AGENT_SYSTEM_PROMPT,
      currentVaultLine,
      vaultList,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Add user message
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmedInput,
      timestamp: new Date(),
    };
    updateThreadMessages(threadId, (prev) => [...prev, userMessage]);
    setInput('');
    setIsProcessing(true);

    // Create tool executor
    const executor = new ToolExecutor({
      getVaultKey: async (vaultId, vaultName, hasPassword) => {
        return getVaultKey(vaultId, vaultName, hasPassword);
      },
      getVaultInfo,
      getVaults: () => vaults,
      confirmAction,
      onDataChange,
    });

    const provider = aiService.getActiveProvider();
    if (!provider) {
      updateThreadMessages(threadId, (prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'assistant',
          content: 'No AI provider configured. Please set up an AI provider in Settings.',
          timestamp: new Date(),
        },
      ]);
      setIsProcessing(false);
      return;
    }

    const callbacks: AgentCallbacks = {
      onToolCall: (toolCall) => {
        updateThreadMessages(threadId, (prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'tool',
            content: '',
            toolCall,
            toolStatus: 'running',
            timestamp: new Date(),
          },
        ]);
      },
      onToolResult: (toolCall, result) => {
        updateThreadMessages(threadId, (prev) =>
          prev.map((msg) =>
            msg.toolCall?.id === toolCall.id
              ? { ...msg, toolStatus: result.success ? 'success' : 'error' }
              : msg
          )
        );
      },
      onMessage: (role, content) => {
        if (role === 'assistant') {
          updateThreadMessages(threadId, (prev) => [
            ...prev,
            {
              id: generateId(),
              role: 'assistant',
              content,
              timestamp: new Date(),
            },
          ]);
        }
      },
      onError: (error) => {
        updateThreadMessages(threadId, (prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: `Sorry, I encountered an error: ${error.message}`,
            timestamp: new Date(),
          },
        ]);
      },
    };

    try {
      await runAgentLoop(trimmedInput, provider, executor, callbacks, {
        systemPrompt,
        conversationHistory,
      });
    } catch (error) {
      // Error already handled by onError callback
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
    inputRef.current?.focus();
  };

  const renderToolCall = (msg: ChatMessage) => {
    const statusClass = msg.toolStatus || 'running';
    return (
      <div className={`${styles.toolCall} ${styles[statusClass]}`}>
        <span className={styles.toolStatusIcon}>
          {msg.toolStatus === 'running' && <span className={styles.spinner} />}
          {msg.toolStatus === 'success' && (
            <CheckCircleIcon className={styles.toolIcon} />
          )}
          {msg.toolStatus === 'error' && (
            <ExclamationCircleIcon className={styles.toolIcon} />
          )}
        </span>
        <span className={styles.toolCopy}>
          <span className={styles.toolName}>{msg.toolCall?.name}</span>
          <span className={styles.toolStatus}>
            {msg.toolStatus === 'running' && 'Running'}
            {msg.toolStatus === 'success' && 'Done'}
            {msg.toolStatus === 'error' && 'Failed'}
          </span>
        </span>
      </div>
    );
  };

  const renderMessageContent = (content: string) => {
    return (
      <div className={styles.markdown}>
        <ReactMarkdown
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
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
          {content}
        </ReactMarkdown>
      </div>
    );
  };

  return (
    <div className={`${styles.container} ${variant === 'page' ? styles.page : ''}`} data-testid="brainy-chat">
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span
            className={`${styles.presenceDot} ${!isConfigured ? styles.offline : ''}`}
            aria-hidden="true"
          />
          <div className={styles.headerText}>
            <div className={styles.title}>brainy</div>
            <div className={styles.subtitle}>
              {isConfigured ? 'Ready in this workspace' : 'AI provider needed'}
            </div>
          </div>
        </div>
        <div className={styles.headerActions}>
          {onOpenSettings && (
            <button
              className={styles.iconButton}
              onClick={onOpenSettings}
              aria-label="Open brainy settings"
              title="AI Settings"
            >
              <Cog6ToothIcon className={styles.icon} />
            </button>
          )}
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <XMarkIcon style={{ width: 20, height: 20 }} />
          </button>
        </div>
      </div>

      <div className={styles.threadBar}>
        <div className={styles.threadSelectWrap}>
          <ChatBubbleLeftRightIcon className={styles.threadIcon} />
          <span className={styles.threadLabel}>Chat</span>
          <select
            className={styles.threadSelect}
            value={activeThreadId || ''}
            onChange={(e) => setActiveThreadId(e.target.value || null)}
            disabled={isProcessing || threads.length === 0}
            aria-label="Select chat thread"
          >
            {threads.length === 0 ? (
              <option value="">No chats yet</option>
            ) : (
              threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))
            )}
          </select>
        </div>
        <div className={styles.threadActions}>
          <button
            className={styles.threadButton}
            onClick={createNewThread}
            title="New chat"
            aria-label="New chat"
          >
            <PlusIcon className={styles.icon} />
          </button>
          <button
            className={styles.threadButton}
            onClick={() => activeThread && compactThread(activeThread.id)}
            title={isCompacting ? 'Compacting...' : 'Compact chat'}
            aria-label="Compact chat"
            disabled={!activeThread || isProcessing || isCompacting || !isConfigured}
          >
            <ArrowsPointingInIcon className={styles.icon} />
          </button>
          <button
            className={styles.threadButton}
            onClick={renameActiveThread}
            title="Rename chat"
            aria-label="Rename chat"
            disabled={!activeThread || isProcessing}
          >
            <PencilSquareIcon className={styles.icon} />
          </button>
          <button
            className={styles.threadButton}
            onClick={deleteActiveThread}
            title="Delete chat"
            aria-label="Delete chat"
            disabled={!activeThread || isProcessing}
          >
            <TrashIcon className={styles.icon} />
          </button>
        </div>
      </div>

      <div className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyKicker}>brainy</div>
            <div className={styles.emptyStateTitle}>What should we work on?</div>
            <div className={styles.emptyStateHint}>
              Search, summarize, create, or organize content across your vaults.
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`${styles.message} ${styles[msg.role]}`}>
              {msg.role !== 'tool' && (
                <div className={styles.messageHeader}>
                  <span className={styles.messageLabel}>
                    {msg.role === 'user' ? 'You' : 'brainy'}
                  </span>
                  <span className={styles.messageTime}>{formatMessageTime(msg.timestamp)}</span>
                </div>
              )}
              {msg.role === 'tool' ? (
                renderToolCall(msg)
              ) : (
                <div className={styles.messageBubble}>{renderMessageContent(msg.content)}</div>
              )}
            </div>
          ))
        )}
        {isProcessing && messages[messages.length - 1]?.role !== 'tool' && (
          <div className={`${styles.message} ${styles.assistant}`}>
            <div className={styles.messageHeader}>
              <span className={styles.messageLabel}>brainy</span>
            </div>
            <div className={`${styles.messageBubble} ${styles.typing}`}>
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {messages.length === 0 && (
        <div className={styles.suggestions}>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className={styles.suggestion}
              onClick={() => handleSuggestionClick(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className={styles.inputArea}>
        <div className={styles.composer}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isConfigured ? 'Ask brainy...' : 'Configure AI provider in Settings first'}
            disabled={!isConfigured || isProcessing}
            rows={1}
          />
          <button
            className={styles.sendButton}
            onClick={handleSend}
            disabled={!input.trim() || isProcessing || !isConfigured}
            aria-label="Send"
          >
            <PaperAirplaneIcon className={styles.sendIcon} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default BrainyChat;
