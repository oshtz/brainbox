/**
 * AI Settings Component
 *
 * Provides UI for configuring AI providers:
 * - Select active provider
 * - Configure provider settings (API keys, base URLs, models)
 * - Test connection
 */

import React, { useState, useEffect, useMemo } from 'react';
import { aiService, ProviderType, PROVIDER_CONFIGS, BrainyUIMode } from '../../utils/ai';
import styles from './AISettings.module.css';

export const AISettings: React.FC = () => {
  const [activeProvider, setActiveProvider] = useState<ProviderType>(
    aiService.getActiveProviderType()
  );
  const [providerSettings, setProviderSettings] = useState(
    aiService.getProviderSettings(activeProvider)
  );
  const [systemPrompt, setSystemPrompt] = useState(aiService.getSystemPrompt());
  const [brainyMode, setBrainyMode] = useState<BrainyUIMode>(aiService.getBrainyMode());
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [testPrompt, setTestPrompt] = useState('Summarize brainbox in one sentence.');
  const [error, setError] = useState('');

  const config = useMemo(() => PROVIDER_CONFIGS[activeProvider], [activeProvider]);

  useEffect(() => {
    const settings = aiService.getProviderSettings(activeProvider);
    setProviderSettings(settings);
    setModels([]);
    setError('');
    setTestResult('');
  }, [activeProvider]);

  const handleProviderChange = (type: ProviderType) => {
    setActiveProvider(type);
    aiService.setActiveProvider(type);
  };

  const handleSettingChange = (key: keyof typeof providerSettings, value: string | boolean) => {
    const newSettings = { ...providerSettings, [key]: value };
    setProviderSettings(newSettings);
    aiService.updateProviderSettings(activeProvider, { [key]: value });
  };

  const handleRefreshModels = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await aiService.listModels(activeProvider);
      setModels(list);
    } catch (e) {
      setError(String(e));
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setLoading(true);
    setError('');
    setTestResult('');
    try {
      const result = await aiService.generate({ prompt: testPrompt });
      setTestResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSystemPrompt = () => {
    aiService.setSystemPrompt(systemPrompt);
  };

  const handleBrainyModeChange = (mode: BrainyUIMode) => {
    setBrainyMode(mode);
    aiService.setBrainyMode(mode);
  };

  const canTest = useMemo(
    () => !!providerSettings.model && !loading,
    [providerSettings.model, loading]
  );

  const providers = Object.values(PROVIDER_CONFIGS);

  return (
    <div className={styles.container}>
      {/* Provider Selection */}
      <div className={styles.section}>
        <span className={styles.sectionLabel}>AI Provider</span>
        <div className={styles.providerGrid}>
          {providers.map((p) => (
            (() => {
              const providerCardSettings = aiService.getProviderSettings(p.type);
              const hasApiKey = !!providerCardSettings.apiKey?.trim();
              const badgeClassName = [
                styles.apiKeyBadge,
                p.requiresApiKey ? '' : styles.apiKeyBadgePlaceholder,
                p.requiresApiKey && hasApiKey ? styles.apiKeyBadgeReady : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <button
                  key={p.type}
                  type="button"
                  className={`${styles.providerCard} ${activeProvider === p.type ? styles.active : ''}`}
                  onClick={() => handleProviderChange(p.type)}
                >
                  <span className={styles.providerName}>{p.name}</span>
                  <span className={styles.providerDesc}>{p.description}</span>
                  <span
                    className={badgeClassName}
                    aria-hidden={!p.requiresApiKey}
                  >
                    API Key
                  </span>
                </button>
              );
            })()
          ))}
        </div>
      </div>

      {/* Provider Configuration */}
      <div className={styles.section}>
        <span className={styles.sectionLabel}>{config.name} Settings</span>

        <div className={styles.formGrid}>
          {/* API Key (for cloud providers) */}
          {config.requiresApiKey && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>API Key</label>
              <input
                type="password"
                value={providerSettings.apiKey || ''}
                onChange={(e) => handleSettingChange('apiKey', e.target.value)}
                placeholder={`Enter your ${config.name} API key`}
                className={styles.input}
              />
            </div>
          )}

          {/* Base URL */}
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Base URL</label>
            <input
              type="text"
              value={providerSettings.baseUrl || ''}
              onChange={(e) => handleSettingChange('baseUrl', e.target.value)}
              placeholder={config.defaultBaseUrl}
              className={styles.input}
            />
          </div>

          {/* Model Selection */}
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Model</label>
            <div className={styles.modelRow}>
              <select
                value={providerSettings.model || ''}
                onChange={(e) => handleSettingChange('model', e.target.value)}
                className={styles.select}
              >
                <option value="">
                  {loading ? 'Loading models...' : models.length ? 'Select a model' : 'No models loaded'}
                </option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {/* Allow custom model entry if not in list */}
                {providerSettings.model && !models.includes(providerSettings.model) && (
                  <option value={providerSettings.model}>{providerSettings.model}</option>
                )}
              </select>
              <button
                type="button"
                onClick={handleRefreshModels}
                className={styles.refreshButton}
                disabled={loading}
              >
                {loading ? '...' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* System Prompt */}
      <div className={styles.section}>
        <span className={styles.sectionLabel}>brainy System Prompt</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          className={styles.textarea}
          rows={6}
        />
        <div className={styles.actions}>
          <button type="button" onClick={handleSaveSystemPrompt} className={styles.button}>
            Save Prompt
          </button>
        </div>
      </div>

      {/* brainy UI Mode */}
      <div className={styles.section}>
        <span className={styles.sectionLabel}>brainy UI Mode</span>
        <div className={styles.modeToggle}>
          <button
            type="button"
            className={`${styles.modeButton} ${brainyMode === 'sidebar' ? styles.modeButtonActive : ''}`}
            onClick={() => handleBrainyModeChange('sidebar')}
          >
            Sidebar
          </button>
          <button
            type="button"
            className={`${styles.modeButton} ${brainyMode === 'full' ? styles.modeButtonActive : ''}`}
            onClick={() => handleBrainyModeChange('full')}
          >
            Full Tab
          </button>
        </div>
        <p className={styles.modeHint}>
          Sidebar keeps brainy docked next to your workspace. Full Tab opens the dedicated brainy screen.
        </p>
      </div>

      {/* Test Section */}
      <div className={styles.section}>
        <span className={styles.sectionLabel}>Quick Test</span>
        <div className={styles.testRow}>
          <input
            type="text"
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            className={styles.input}
            placeholder="Enter a test prompt"
          />
          <button
            type="button"
            onClick={handleTest}
            className={styles.primaryButton}
            disabled={!canTest}
          >
            {loading ? 'Working...' : 'Test'}
          </button>
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {testResult && (
          <pre className={styles.testResult}>{testResult}</pre>
        )}
      </div>
    </div>
  );
};

export default AISettings;
