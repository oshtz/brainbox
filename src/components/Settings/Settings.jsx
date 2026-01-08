import React, { useEffect, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useHotkey } from '../../contexts/HotkeyContext';
import { KeyManagement } from '../KeyManagement';
import { ExportImport } from '../ExportImport';
import { AISettings } from '../AISettings';

const BOOKMARKLET_PROTOCOL = `javascript:(function(){try{var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title),p='brainbox://capture?url='+u+'&title='+t;location.href=p;setTimeout(function(){try{window.stop();}catch(e){}},350);}catch(e){console.log('Bookmarklet error:',e&&e.message?e.message:e);}})();`;

const BOOKMARKLET_LOCALHOST = `javascript:(function(){try{var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);window.open('http://127.0.0.1:51234/capture?url='+u+'&title='+t,'_blank');}catch(e){console.log('Bookmarklet error:',e&&e.message?e.message:e);}})();`;

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
                    style={{ ...buttonStyle, background: 'var(--color-accent)', color: '#fff', border: '1px solid var(--color-accent)' }}
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
              Drag a button to your bookmarks bar to capture the page you are viewing. The localhost version keeps your current tab in place.
            </p>
            <div style={bookmarkletButtonsStyle}>
              <a
                href={BOOKMARKLET_LOCALHOST}
                style={bookmarkletLinkStyle('primary')}
                draggable="true"
                tabIndex={0}
                aria-label="Drag to bookmarks to install capture bookmarklet using localhost"
              >
                Capture (Localhost - Recommended)
              </a>
              <a
                href={BOOKMARKLET_PROTOCOL}
                style={bookmarkletLinkStyle('secondary')}
                draggable="true"
                tabIndex={0}
                aria-label="Drag to bookmarks to install capture bookmarklet using protocol handler"
              >
                Capture (Protocol)
              </a>
            </div>
            <p style={bodyTextMutedStyle}>
              Tip: If you cannot drag, right-click the button and choose "Bookmark link". Configure HTTPS-only mode to allow 127.0.0.1 if needed.
            </p>
            <div style={inlineActionRowStyle}>
              <button
                type="button"
                style={{ ...buttonStyle, background: 'var(--color-accent)', color: '#fff', border: '1px solid var(--color-accent)' }}
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

const Settings = ({ scrollToSection, onScrollComplete }) => {
  const { accent, setAccent, theme, toggleTheme } = useTheme();

  // Handle scroll to section when navigating from another page
  useEffect(() => {
    if (scrollToSection) {
      // Small delay to ensure the DOM is ready
      const timer = setTimeout(() => {
        const element = document.getElementById(scrollToSection);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Highlight the section briefly
          element.style.transition = 'box-shadow 0.3s ease';
          element.style.boxShadow = '0 0 0 3px var(--color-accent)';
          setTimeout(() => {
            element.style.boxShadow = '';
          }, 2000);
        }
        if (onScrollComplete) {
          onScrollComplete();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [scrollToSection, onScrollComplete]);

  const presets = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#06b6d4', '#e879f9', '#3b82f6', '#14b8a6'];
  const accentLabel = String(accent || '').toUpperCase() || '--';
  const toggleLabel = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return (
    <div style={pageStyle} data-testid="settings-section">
      <CaptureSettings />
      <SettingCard
        title="Appearance"
        description="Tune colors and theme to match your workspace."
        action={
          <button
            type="button"
            onClick={toggleTheme}
            style={{ ...buttonStyle, minWidth: 180 }}
          >
            {toggleLabel}
          </button>
        }
      >
        <div style={appearanceLayoutStyle}>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Accent color</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  aria-label="Pick accent color"
                  style={colorPickerStyle}
                />
                <span style={accentBadgeStyle}>{accentLabel}</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <span style={subtleLabelStyle}>Quick presets</span>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {presets.map((c) => {
                const isActive = accent === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setAccent(c)}
                    aria-label={`Set accent ${c}`}
                    style={presetButtonStyle(c, isActive)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        title="Security"
        description="Manage vault encryption keys and session security."
      >
        <KeyManagement />
      </SettingCard>

      <SettingCard
        title="Backup & Transfer"
        description="Export and import your vaults for backup or transfer to another device."
      >
        <ExportImport />
      </SettingCard>

      <SettingCard
        id="ai-settings"
        title="AI"
        description="Configure AI providers for note summarization and chat."
      >
        <AISettings />
      </SettingCard>
      <UpdateSettings />

    </div>
  );
};

export default Settings;

const pageStyle = {
  padding: '2.5rem 2rem',
  display: 'grid',
  gap: '1.75rem',
  maxWidth: 960,
  margin: '0 auto',
};

const appearanceLayoutStyle = {
  display: 'grid',
  gap: '1.25rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  alignItems: 'center',
};

const cardStyle = {
  background: 'var(--color-elevated)',
  borderRadius: 16,
  border: '1px solid var(--color-border)',
  padding: '1.75rem',
  boxShadow: '0px 18px 40px rgba(15, 23, 42, 0.12)',
};

const cardHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1.5rem',
  flexWrap: 'wrap',
  marginBottom: '1.5rem',
};

const cardTitleStyle = {
  margin: 0,
  fontSize: '1.15rem',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const cardDescriptionStyle = {
  margin: '0.35rem 0 0',
  fontSize: '0.95rem',
  color: 'var(--color-text-secondary)',
  lineHeight: 1.4,
};

const cardBodyStyle = {
  display: 'grid',
  gap: '1.5rem',
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
  padding: '0.65rem 0.9rem',
  borderRadius: 10,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  width: '100%',
  fontSize: '0.95rem',
};

const buttonStyle = {
  padding: '0.6rem 1.1rem',
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.95rem',
  transition: 'transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease',
  boxShadow: '0 10px 20px rgba(15, 23, 42, 0.08)',
};

const colorPickerStyle = {
  width: 46,
  height: 36,
  padding: 0,
  border: '1px solid var(--color-border)',
  background: 'transparent',
  borderRadius: 10,
  cursor: 'pointer',
};

const accentBadgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  padding: '0.35rem 0.75rem',
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  minWidth: 96,
  justifyContent: 'center',
};

const presetButtonStyle = (color, isActive) => ({
  width: 34,
  height: 34,
  borderRadius: '50%',
  border: isActive ? `2px solid var(--color-text-primary)` : '2px solid transparent',
  outline: `1px solid ${isActive ? 'var(--color-text-primary)' : 'var(--color-border)'}`,
  background: color,
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
  boxShadow: isActive ? '0 0 0 4px rgba(99, 102, 241, 0.15)' : '0 8px 20px rgba(15, 23, 42, 0.12)',
  transition: 'transform 0.2s ease, box-shadow 0.2s ease',
  transform: isActive ? 'scale(1.05)' : 'scale(1)',
});

const badgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.35rem 0.75rem',
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
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
  gap: '1.5rem',
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
  padding: '0.65rem 1.15rem',
  borderRadius: 999,
  fontWeight: 600,
  fontSize: '0.95rem',
  textDecoration: 'none',
  cursor: 'grab',
  border: variant === 'primary' ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
  background: variant === 'primary' ? 'var(--color-accent)' : 'var(--color-surface)',
  color: variant === 'primary' ? '#fff' : 'var(--color-text-primary)',
  boxShadow: '0 10px 20px rgba(15, 23, 42, 0.1)',
});

const cardSectionStackStyle = {
  display: 'grid',
  gap: '1.5rem',
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
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
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
  border: '1px solid var(--color-border)',
  borderRadius: 12,
};

const capturePlaceholderStyle = {
  padding: '1.25rem',
  borderRadius: 12,
  border: '1px dashed var(--color-border)',
  background: 'var(--color-elevated)',
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
  background: 'var(--color-surface)',
  borderRadius: 12,
  border: '1px solid var(--color-border)',
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
  background: 'var(--color-surface)',
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
  fontSize: '0.95rem',
};

const progressSectionStyle = {
  display: 'grid',
  gap: '0.5rem',
};

const progressTrackStyle = {
  width: '100%',
  height: 10,
  background: 'var(--color-border)',
  borderRadius: 999,
  overflow: 'hidden',
};

const progressFillStyle = {
  height: '100%',
  background: 'var(--color-accent)',
  transition: 'width 0.3s ease',
};

const progressLabelStyle = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
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
      border: 'var(--color-border)',
      background: 'var(--color-surface)',
      color: 'var(--color-text-secondary)',
    },
    accent: {
      border: 'var(--color-accent)',
      background: 'var(--color-accent-bg, rgba(99, 102, 241, 0.08))',
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
    borderRadius: 12,
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
  const [isUpdating, setIsUpdating] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(0)

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

    // Listen for update progress events
    let unlisten1, unlisten2;
    
    listen('update-progress', (event) => {
      setUpdateProgress(event.payload)
    }).then(fn => { unlisten1 = fn }).catch(() => {})

    listen('update-downloaded', () => {
      setUpdateStatus('Update downloaded! Restarting application...')
    }).then(fn => { unlisten2 = fn }).catch(() => {})

    return () => {
      if (unlisten1) unlisten1()
      if (unlisten2) unlisten2()
    }
  }, [])

  async function checkForUpdates() {
    setIsChecking(true)
    setUpdateStatus('')
    try {
      const result = await invoke('check_for_updates')
      if (result) {
        setUpdateStatus(result)
      } else {
        setUpdateStatus('You are running the latest version!')
      }
    } catch (e) {
      setUpdateStatus(`Error checking for updates: ${e}`)
    } finally {
      setIsChecking(false)
    }
  }

  async function installUpdate() {
    setIsUpdating(true)
    setUpdateProgress(0)
    setUpdateStatus('Downloading update...')
    try {
      await invoke('install_update')
      // App will restart automatically after successful update
    } catch (e) {
      setUpdateStatus(`Error installing update: ${e}`)
      setIsUpdating(false)
    }
  }

  const hasUpdate = updateStatus.includes('Update available')
  const releaseName = formatReleaseName(currentVersion)

  return (
    <SettingCard
      title="App updates"
      description="Stay on the latest release and pick up fixes the moment they land."
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
            style={{ ...buttonStyle, opacity: isChecking || isUpdating ? 0.6 : 1 }}
            disabled={isChecking || isUpdating}
          >
            {isChecking ? 'Checking...' : 'Check for updates'}
          </button>

          {hasUpdate && (
            <button
              type="button"
              onClick={installUpdate}
              style={{
                ...buttonStyle,
                background: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                color: '#fff',
                opacity: isUpdating ? 0.7 : 1,
              }}
              disabled={isUpdating}
            >
              {isUpdating ? 'Installing...' : 'Install update'}
            </button>
          )}
        </div>

        {isUpdating && updateProgress > 0 && (
          <div style={progressSectionStyle}>
            <div style={progressTrackStyle}>
              <div style={{ ...progressFillStyle, width: `${updateProgress}%` }} />
            </div>
            <span style={progressLabelStyle}>
              {Math.round(updateProgress)}% downloaded
            </span>
          </div>
        )}

        {updateStatus && (
          <div style={statusBubbleStyle(hasUpdate ? 'accent' : 'info')} role="status">
            {updateStatus}
          </div>
        )}
      </div>
    </SettingCard>
  )
}

