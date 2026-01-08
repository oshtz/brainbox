import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Props = {
  url: string;
  onImageFound?: (img: string) => void;
  compact?: boolean;
};

type UrlMetadata = {
  final_url: string;
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
};

const LinkPreview: React.FC<Props> = ({ url, onImageFound, compact }) => {
  const [meta, setMeta] = useState<UrlMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<UrlMetadata>('fetch_url_metadata', { url })
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        if (data?.image && onImageFound) onImageFound(data.image);
      })
      .catch(() => { if (!cancelled) setError('Preview unavailable'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url]);

  const host = (() => {
    try { return new URL(meta?.final_url || url).hostname; } catch { return url; }
  })();

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      padding: compact ? 8 : 12,
      background: 'var(--color-surface-elev-1)'
    }}>
      {meta?.image ? (
        <div style={{ width: compact ? 96 : 140, height: compact ? 60 : 84, flex: '0 0 auto', overflow: 'hidden', borderRadius: 8, border: '1px solid var(--color-border)' }}>
          <img src={meta.image} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ) : (
        <div style={{ width: compact ? 96 : 140, height: compact ? 60 : 84, flex: '0 0 auto', borderRadius: 8, background: 'var(--color-surface-elev-2)' }} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          {meta?.favicon && <img src={meta.favicon} alt="" style={{ width: 16, height: 16 }} />}
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{host}</span>
        </div>
        <div style={{ fontWeight: 600, fontSize: compact ? 13 : 15, color: 'var(--color-text-primary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {loading ? 'Loading…' : (meta?.title || meta?.site_name || url)}
        </div>
        {!compact && (
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxHeight: 38, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {error ? error : (meta?.description || '')}
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <a href={url} onClick={(e) => { e.preventDefault(); window.open(url, '_blank'); }} style={{ fontSize: 12 }}>Open link →</a>
        </div>
      </div>
    </div>
  );
};

export default LinkPreview;

