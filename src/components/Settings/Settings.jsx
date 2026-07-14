import React, { useEffect, useState, useCallback } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { invoke } from '@tauri-apps/api/core';
import { useHotkey } from '../../contexts/HotkeyContext';
import { KeyManagement } from '../KeyManagement';
import { ExportImport } from '../ExportImport';
import { AISettings } from '../AISettings';
import { FolderSync } from '../FolderSync/FolderSync';
import {
  LinkIcon,
  SwatchIcon,
  LockClosedIcon,
  CloudArrowDownIcon,
  SparklesIcon,
  ArrowUpCircleIcon,
} from '@heroicons/react/24/outline';
import styles from './Settings.module.css';

// Tab configuration
const TABS = [
  { id: 'capture', label: 'Capture', Icon: LinkIcon },
  { id: 'appearance', label: 'Appearance', Icon: SwatchIcon },
  { id: 'security', label: 'Security', Icon: LockClosedIcon },
  { id: 'data', label: 'Data', Icon: CloudArrowDownIcon },
  { id: 'ai', label: 'AI', Icon: SparklesIcon },
  { id: 'updates', label: 'Updates', Icon: ArrowUpCircleIcon },
];

function TabButton({ tab, isActive, onClick }) {
  const Icon = tab.Icon;
  
  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`panel-${tab.id}`}
      id={`tab-${tab.id}`}
      onClick={onClick}
      className={`${styles.tabButton} ${isActive ? styles.tabButtonActive : ''}`}
    >
      <Icon className={styles.tabIcon} />
      <span className={styles.tabLabel}>{tab.label}</span>
    </button>
  );
}

const BOOKMARKLET_PROTOCOL = `javascript:(function(){try{var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title),p='brainbox://capture?url='+u+'&title='+t;location.href=p;setTimeout(function(){try{window.stop();}catch(e){}},350);}catch(e){console.log('Bookmarklet error:',e&&e.message?e.message:e);}})();`;

const BOOKMARKLET_LOCALHOST = `javascript:(function(){try{var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title),s=String(window.getSelection()).trim(),x='';if(s){if(s.length>2000){s=s.slice(0,2000)+'\\n\\n[Selection truncated]';}x='&selection='+encodeURIComponent(s);}window.open('http://127.0.0.1:51234/capture?url='+u+'&title='+t+x,'_blank');}catch(e){console.log('Bookmarklet error:',e&&e.message?e.message:e);}})();`;

function CaptureSettings() {
  const { hotkey, setHotkey } = useHotkey();
  const [editingHotkey, setEditingHotkey] = useState(false);
  const [tempHotkey, setTempHotkey] = useState(hotkey);
  const [hotkeyError, setHotkeyError] = useState('');
  const [regStatus, setRegStatus] = useState('idle');
  const [regMessage, setRegMessage] = useState('');
  const [capturedUrl, setCapturedUrl] = useState(null);

  useEffect(() => {
    setTempHotkey(hotkey);
  }, [hotkey]);

  useEffect(() => {
    const handleUrlCaptured = (e) => {
      setCapturedUrl(e.detail?.url || null);
    };
    window.addEventListener('brainbox:url-captured', handleUrlCaptured);
    return () => window.removeEventListener('brainbox:url-captured', handleUrlCaptured);
  }, []);

  const handleHotkeyInputChange = (e) => {
    setTempHotkey(e.target.value);
    setHotkeyError('');
  };

  const handleKeyCapture = (e) => {
    let keys = [];
    if (e.altKey) keys.push('Alt');
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.metaKey) keys.push('Meta');
    if (!['Alt', 'Ctrl', 'Shift', 'Meta'].includes(e.key)) {
      keys.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    }
    const hotkeyStr = keys.join('+');
    setTempHotkey(hotkeyStr);
    setHotkeyError('');
    e.preventDefault();
  };

  const handleSaveHotkey = () => {
    if (!tempHotkey.trim()) {
      setHotkeyError('Hotkey cannot be empty.');
      return;
    }
    setHotkey(tempHotkey.trim());
    setEditingHotkey(false);
  };

  const handleCancelHotkey = () => {
    setEditingHotkey(false);
    setTempHotkey(hotkey);
    setHotkeyError('');
  };

  const handleRegisterProtocol = async () => {
    setRegStatus('loading');
    setRegMessage('Registering protocol handler...');
    try {
      await invoke('register_brainbox_protocol');
      setRegStatus('success');
      setRegMessage('Protocol registered! You can now use the bookmarklet.');
    } catch (_) {
      setRegStatus('error');
      setRegMessage('Failed to register protocol. Try running as administrator.');
    }
  };

  const handleBookmarkletDragStart = useCallback((event, bookmarklet) => {
    event.dataTransfer.setData('text/uri-list', bookmarklet);
    event.dataTransfer.setData('text/plain', bookmarklet);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleBookmarkletCopy = useCallback(async (bookmarklet) => {
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setRegStatus('success');
      setRegMessage('Bookmarklet copied. Paste it into a browser bookmark URL.');
    } catch (_) {
      setRegStatus('error');
      setRegMessage('Could not copy bookmarklet. Drag it to your bookmarks bar instead.');
    }
  }, []);

  const statusVariant = regStatus === 'success' ? 'accent' : regStatus === 'error' ? 'danger' : 'info';

  const hotkeySummary = hotkey || 'Not set';

  return (
    <SettingCard
      title="Capture tools"
      description="Install the bookmarklet or trigger capture with a keyboard shortcut."
    >
      <div style={cardSectionStackStyle}>
        <div style={captureCardGridStyle}>
          <div style={hotkeyPanelStyle}>
            <div style={hotkeyMetaRowStyle}>
              <span style={subtleLabelStyle}>Capture hotkey</span>
              <span style={hotkeyBadgeStyle}>{hotkeySummary}</span>
            </div>
            <p style={bodyTextStyle}>
              Use a custom shortcut to open capture without leaving brainbox.
            </p>
            {editingHotkey ? (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <input
                  type="text"
                  value={tempHotkey}
                  onChange={handleHotkeyInputChange}
                  onKeyDown={handleKeyCapture}
                  autoFocus
                  aria-label="Edit capture hotkey"
                  style={hotkeyInputStyle}
                />
                <div style={inlineActionRowStyle}>
                  <button
                    type="button"
                    style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-on-primary)', border: '1px solid var(--color-accent)' }}
                    onClick={handleSaveHotkey}
                  >
                    Save hotkey
                  </button>
                  <button
                    type="button"
                    style={{ ...buttonStyle, opacity: 0.75 }}
                    onClick={handleCancelHotkey}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setEditingHotkey(true)}
              >
                Edit hotkey
              </button>
            )}
            {hotkeyError && (
              <div style={statusBubbleStyle('danger')} role="alert">
                {hotkeyError}
              </div>
            )}

            {capturedUrl ? (
              <div style={capturePreviewStyle}>
                <span style={subtleLabelStyle}>Recent capture preview</span>
                <p style={bodyTextMutedStyle}>
                  Some sites block previews in iframes (X-Frame-Options). Open the capture in brainbox if the preview is blank.
                </p>
                <iframe
                  src={capturedUrl}
                  title="Captured content preview"
                  style={captureIframeStyle}
                  sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                />
              </div>
            ) : (
              <div style={capturePlaceholderStyle}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <span style={subtleLabelStyle}>Waiting for a capture</span>
                  <p style={bodyTextMutedStyle}>
                    Use your hotkey or bookmarklet to send a page. We'll show a live preview here when something arrives.
                  </p>
                </div>
                <div style={inlineActionRowStyle}>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    Need a shortcut? Click "Edit hotkey" above.
                  </span>
                </div>
              </div>
            )}
          </div>

          <div style={bookmarkletPanelStyle}>
            <span style={subtleLabelStyle}>Bookmarklet</span>
            <p style={bodyTextStyle}>
              Drag the button to your bookmarks bar. Select text before using it to capture a sourced note, or use it without a selection to save the page.
            </p>
            <div style={bookmarkletButtonsStyle}>
              <button
                type="button"
                style={bookmarkletLinkStyle('primary')}
                draggable="true"
                onDragStart={(event) => handleBookmarkletDragStart(event, BOOKMARKLET_LOCALHOST)}
                onClick={() => handleBookmarkletCopy(BOOKMARKLET_LOCALHOST)}
                aria-label="Drag to bookmarks to install capture bookmarklet using localhost"
              >
                Capture (Localhost - Recommended)
              </button>
              <button
                type="button"
                style={bookmarkletLinkStyle('secondary')}
                draggable="true"
                onDragStart={(event) => handleBookmarkletDragStart(event, BOOKMARKLET_PROTOCOL)}
                onClick={() => handleBookmarkletCopy(BOOKMARKLET_PROTOCOL)}
                aria-label="Drag to bookmarks to install capture bookmarklet using protocol handler"
              >
                Capture (Protocol)
              </button>
            </div>
            <p style={bodyTextMutedStyle}>
              Tip: If you cannot drag, right-click the button and choose "Bookmark link". Configure HTTPS-only mode to allow 127.0.0.1 if needed.
            </p>
            <div style={inlineActionRowStyle}>
              <button
                type="button"
                style={{ ...buttonStyle, background: 'var(--color-accent)', color: 'var(--color-on-primary)', border: '1px solid var(--color-accent)' }}
                onClick={handleRegisterProtocol}
              >
                Register Protocol Handler (Windows)
              </button>
            </div>
            {regStatus !== 'idle' && regMessage && (
              <div style={statusBubbleStyle(statusVariant)} role="status">
                {regMessage}
              </div>
            )}
          </div>
        </div>

      </div>
    </SettingCard>
  );
}

// Appearance Settings Panel
function AppearanceSettings() {
  const { theme, toggleTheme } = useTheme();
  const toggleLabel = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return (
    <SettingCard
      title="Appearance"
      description="Choose a neutral light or dark workspace."
      action={
        <button
          type="button"
          onClick={toggleTheme}
          style={{ ...buttonStyle, minWidth: 180 }}
        >
          {toggleLabel}
        </button>
      }
    />
  );
}

// Security Settings Panel
function SecuritySettings() {
  return (
    <SettingCard
      title="Security"
      description="Manage vault encryption keys and session security."
    >
      <KeyManagement />
    </SettingCard>
  );
}

// Backup Settings Panel
function BackupSettings() {
  return (
    <SettingCard
      id="backup-settings"
      title="Backups & restore"
      description="Create or restore a manual encrypted point-in-time backup."
    >
      <ExportImport />
    </SettingCard>
  );
}

function SyncSettings({ onDataChange }) {
  return (
    <SettingCard
      id="sync-settings"
      title="Sync between devices"
      description="Use an encrypted local folder with Syncthing or your existing cloud-drive app."
    >
      <FolderSync onDataChange={onDataChange} />
    </SettingCard>
  );
}

// AI Settings Panel
function AISettingsPanel() {
  return (
    <SettingCard
      id="ai-settings"
      title="AI"
      description="Configure AI providers for note summarization and chat."
    >
      <AISettings />
    </SettingCard>
  );
}

const Settings = ({ scrollToSection, onScrollComplete, onSyncDataChange }) => {
  const [activeTab, setActiveTab] = useState('capture');

  // Map scrollToSection values to tab IDs
  const sectionToTab = {
    'ai-settings': 'ai',
    'sync-settings': 'data',
    'capture-settings': 'capture',
    'appearance-settings': 'appearance',
    'security-settings': 'security',
    'backup-settings': 'data',
    'update-settings': 'updates',
  };

  // Handle scroll to section when navigating from another page
  useEffect(() => {
    if (scrollToSection) {
      const timer = setTimeout(() => {
        // Map the scroll section to a tab
        const tabId = sectionToTab[scrollToSection] || scrollToSection;
        const validTab = TABS.find(t => t.id === tabId);
        if (validTab) {
          setActiveTab(tabId);
        }
        if (onScrollComplete) {
          onScrollComplete();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollToSection, onScrollComplete]);

  const handleTabChange = useCallback((tabId) => {
    setActiveTab(tabId);
  }, []);

  // Render the active tab's content
  const renderTabContent = () => {
    switch (activeTab) {
      case 'capture':
        return <CaptureSettings />;
      case 'appearance':
        return <AppearanceSettings />;
      case 'security':
        return <SecuritySettings />;
      case 'data':
        return <><SyncSettings onDataChange={onSyncDataChange} /><BackupSettings /></>;
      case 'ai':
        return <AISettingsPanel />;
      case 'updates':
        return <UpdateSettings />;
      default:
        return <CaptureSettings />;
    }
  };

  return (
    <section className={styles.settings} data-testid="settings-section">
      <header className={styles.pageHeader}>
        <h1>Settings</h1>
        <p>Manage capture, privacy, backups, AI, and updates.</p>
      </header>

      <div className={styles.layout}>
        <div className={styles.navWrap}>
          <nav className={styles.tabNav} role="tablist" aria-label="Settings sections">
          {TABS.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              isActive={activeTab === tab.id}
              onClick={() => handleTabChange(tab.id)}
            />
          ))}
          </nav>
        </div>

        <div
          className={styles.tabContent}
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
        >
          {renderTabContent()}
        </div>
      </div>
    </section>
  );
};

export default Settings;

const cardStyle = {
  background: 'transparent',
  border: 0,
  borderRadius: 0,
  padding: '0 0 var(--space-2xl)',
  boxShadow: 'none',
};

const cardHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
  marginBottom: '1rem',
};

const cardTitleStyle = {
  margin: 0,
  fontSize: 'clamp(1.35rem, 2vw, 1.7rem)',
  fontWeight: 600,
  letterSpacing: '-0.035em',
  color: 'var(--color-text-primary)',
};

const cardDescriptionStyle = {
  margin: '0.35rem 0 0',
  maxWidth: '65ch',
  fontSize: '0.92rem',
  color: 'var(--color-text-secondary)',
  lineHeight: 1.55,
};

const cardBodyStyle = {
  display: 'grid',
  gap: '1rem',
};

const subtleLabelStyle = {
  fontSize: '0.85rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.9rem',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 6,
};

const inputStyle = {
  padding: '8px 10px',
  borderRadius: 'var(--border-radius-md)',
  border: '1px solid var(--ui-muted-border)',
  background: 'var(--ui-input-bg)',
  color: 'var(--color-text-primary)',
  width: '100%',
  fontSize: 'var(--font-size-sm)',
};

const buttonStyle = {
  padding: '0.45rem 0.75rem',
  borderRadius: 'var(--border-radius-md)',
  border: '1px solid transparent',
  background: 'var(--ui-control-bg)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.85rem',
  transition: 'background-color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease',
  boxShadow: 'none',
};

const badgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.35rem 0.75rem',
  borderRadius: 'var(--border-radius-md)',
  border: '1px solid transparent',
  background: 'var(--ui-control-bg)',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const bodyTextStyle = {
  margin: 0,
  fontSize: '0.95rem',
  color: 'var(--color-text-secondary)',
  lineHeight: 1.5,
};

const bodyTextMutedStyle = {
  ...bodyTextStyle,
  opacity: 0.85,
};

const captureCardGridStyle = {
  display: 'grid',
  gap: '1rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  alignItems: 'start',
};

const bookmarkletPanelStyle = {
  display: 'grid',
  gap: '0.85rem',
};

const bookmarkletButtonsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
};

const bookmarkletLinkStyle = (variant = 'primary') => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.5rem 0.85rem',
  borderRadius: 'var(--border-radius-md)',
  fontWeight: 600,
  fontSize: '0.85rem',
  fontFamily: 'var(--font-family-body)',
  textDecoration: 'none',
  cursor: 'grab',
  border: variant === 'primary' ? '1px solid var(--color-accent)' : '1px solid transparent',
  background: variant === 'primary' ? 'var(--color-accent)' : 'var(--ui-control-bg)',
  color: variant === 'primary' ? '#fff' : 'var(--color-text-primary)',
  boxShadow: 'none',
});

const cardSectionStackStyle = {
  display: 'grid',
  gap: '1rem',
};

const formGridStyle = {
  display: 'grid',
  gap: '1rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  alignItems: 'end',
};

const inlineActionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
};

const hotkeyPanelStyle = {
  display: 'grid',
  gap: '0.85rem',
};

const hotkeyBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 96,
  padding: '0.5rem 0.85rem',
  borderRadius: 'var(--border-radius-md)',
  border: '1px solid transparent',
  background: 'var(--ui-control-bg)',
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const hotkeyInputStyle = {
  ...inputStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  textTransform: 'uppercase',
};

const hotkeyMetaRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  flexWrap: 'wrap',
};

const capturePreviewStyle = {
  display: 'grid',
  gap: '0.75rem',
};

const captureIframeStyle = {
  width: '100%',
  minHeight: 320,
  border: '1px solid var(--ui-hairline-border)',
  borderRadius: 'var(--border-radius-lg)',
};

const capturePlaceholderStyle = {
  padding: '1.25rem',
  borderRadius: 'var(--border-radius-lg)',
  border: '1px dashed var(--ui-dashed-border)',
  background: 'var(--ui-control-bg)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  width: '100%',
  minHeight: 160,
};

const textareaStyle = {
  ...inputStyle,
  minHeight: 160,
  resize: 'vertical',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  lineHeight: 1.45,
};

const vaultCardStyle = {
  padding: '1.1rem 1.25rem',
  background: 'var(--ui-control-bg)',
  borderRadius: 'var(--border-radius-lg)',
  border: '1px solid transparent',
  display: 'grid',
  gap: '0.65rem',
};

const vaultHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
};

const vaultCountStyle = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
};

const vaultEmptyStyle = {
  color: 'var(--color-text-secondary)',
  fontSize: '0.92rem',
};

const vaultListStyle = {
  margin: 0,
  paddingLeft: 18,
  display: 'grid',
  gap: '0.35rem',
};

const vaultListItemStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  color: 'var(--color-text-primary)',
};

const vaultMetaStyle = {
  color: 'var(--color-text-secondary)',
  fontSize: '0.85rem',
};

const testGridStyle = {
  display: 'grid',
  gap: '0.75rem',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
};

const testResultStyle = {
  margin: 0,
  padding: '1rem',
  background: 'var(--ui-control-bg)',
  borderRadius: 'var(--border-radius-lg)',
  border: '1px solid transparent',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
  fontSize: '0.95rem',
};

function SettingCard({ id, title, description, action, children }) {
  return (
    <section id={id} style={cardStyle}>
      <header style={{ ...cardHeaderStyle, marginBottom: children ? cardHeaderStyle.marginBottom : 0 }}>
        <div style={{ flex: '1 1 auto' }}>
          <h2 style={cardTitleStyle}>{title}</h2>
          {description && <p style={cardDescriptionStyle}>{description}</p>}
        </div>
        {action && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {action}
          </div>
        )}
      </header>
      {children && <div style={cardBodyStyle}>{children}</div>}
    </section>
  );
}

const statusBubbleStyle = (variant = 'info') => {
  const palette = {
    info: {
      border: 'transparent',
      background: 'var(--ui-control-bg)',
      color: 'var(--color-text-secondary)',
    },
    accent: {
      border: 'var(--color-accent)',
      background: 'var(--color-accent-bg, rgba(127, 127, 127, 0.08))',
      color: 'var(--color-accent)',
    },
    danger: {
      border: 'var(--color-danger, #ef4444)',
      background: 'rgba(239, 68, 68, 0.08)',
      color: 'var(--color-danger, #ef4444)',
    },
  }[variant] || {
    border: 'var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  };

  return {
    padding: '0.75rem 1rem',
    borderRadius: 'var(--border-radius-md)',
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.color,
    fontSize: '0.92rem',
    lineHeight: 1.4,
  };
};

const formatReleaseName = (version) => {
  const normalized = String(version || '').trim().replace(/^v/i, '');
  return normalized ? `brainbox v${normalized}` : '';
};

function UpdateSettings() {
  const [currentVersion, setCurrentVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState('')
  const [isChecking, setIsChecking] = useState(false)

  useEffect(() => {
    // Get current version on component mount
    ;(async () => {
      try {
        const version = await invoke('get_current_version')
        setCurrentVersion(version)
      } catch (e) {
        console.error('Failed to get current version:', e)
      }
    })()

  }, [])

  async function checkForUpdates() {
    setIsChecking(true)
    setUpdateStatus('')
    try {
      const result = await invoke('check_for_updates')
      if (result && result.version) {
        setUpdateStatus(`Update available: v${result.version}`)
      } else {
        setUpdateStatus('You are running the latest version.')
      }
    } catch (e) {
      setUpdateStatus(`Error checking for updates: ${e}`)
    } finally {
      setIsChecking(false)
    }
  }

  const hasUpdate = typeof updateStatus === 'string' && updateStatus.includes('Update available')
  const releaseName = formatReleaseName(currentVersion)
  const releasesUrl = 'https://github.com/oshtz/brainbox/releases/latest'

  return (
    <SettingCard
      title="App updates"
      description="Check for a release, then download it manually from GitHub."
      action={
        <div style={badgeStyle} aria-live="polite">
          <span style={{ opacity: 0.65 }}>Version</span>
          <span>{releaseName || '--'}</span>
        </div>
      }
    >
      <div style={cardSectionStackStyle}>
        <div style={inlineActionRowStyle}>
          <button
            type="button"
            onClick={checkForUpdates}
            style={{ ...buttonStyle, opacity: isChecking ? 0.6 : 1 }}
            disabled={isChecking}
          >
            {isChecking ? 'Checking...' : 'Check for updates'}
          </button>

          <a href={releasesUrl} target="_blank" rel="noreferrer" style={buttonStyle}>
            Open GitHub Releases
          </a>
          <button type="button" style={buttonStyle} onClick={() => navigator.clipboard.writeText(releasesUrl)}>
            Copy release link
          </button>
        </div>

        {updateStatus && (
          <div style={statusBubbleStyle(hasUpdate ? 'accent' : 'info')} role="status">
            {updateStatus}
          </div>
        )}
      </div>
    </SettingCard>
  )
}

