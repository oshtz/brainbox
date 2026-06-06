import React, { useState, useEffect, useMemo, useRef } from "react";
import { useTransition, a } from "@react-spring/web";
import { PlayIcon, ArrowUpIcon, ArrowDownIcon, TrashIcon, EllipsisVerticalIcon, PlusIcon } from "@heroicons/react/24/solid";
import "./Masonry.css";
import { faviconForUrl } from "../../utils/urlPreview";

export interface MasonryItem {
  id: string | number;
  height: number;
  image: string;
  title?: string;
  content?: string;
  // Optional metadata hints used by the grid
  metadata?: {
    item_type?: string;
    provider?: string;
    url?: string;
    preview_title?: string;
    preview_description?: string;
    preview_image?: string;
  };
}

interface GridItem extends MasonryItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MasonryProps {
  data: MasonryItem[];
  onCardClick?: (item: MasonryItem) => void;
  onDeleteItem?: (item: MasonryItem) => void;
  onMoveItem?: (item: MasonryItem, direction: "up" | "down") => void;
  alwaysShowOverlay?: boolean;
  actionsMode?: 'buttons' | 'menu';
  selectedId?: string | number | null;
}

const Masonry: React.FC<MasonryProps> = ({ data, onCardClick, onDeleteItem, onMoveItem, alwaysShowOverlay = false, actionsMode = 'buttons', selectedId = null }) => {
  const [columns, setColumns] = useState<number>(2);
  const [openMenuFor, setOpenMenuFor] = useState<string | number | null>(null);
  // Track measured overlay heights for URL previews keyed by item id
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const observersRef = useRef<Map<string, ResizeObserver>>(new Map());

  useEffect(() => {
    const updateColumns = () => {
      if (window.matchMedia("(min-width: 1500px)").matches) {
        setColumns(5);
      } else if (window.matchMedia("(min-width: 1000px)").matches) {
        setColumns(4);
      } else if (window.matchMedia("(min-width: 600px)").matches) {
        setColumns(3);
      } else {
        setColumns(1);
      }
    };
    updateColumns();
    window.addEventListener("resize", updateColumns);
    return () => window.removeEventListener("resize", updateColumns);
  }, []);

  // Disconnect observers on unmount
  useEffect(() => {
    return () => {
      observersRef.current.forEach((ro) => ro.disconnect());
      observersRef.current.clear();
    };
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(0);
  useEffect(() => {
    const handleResize = () => {
      if (ref.current) {
        setWidth(ref.current.offsetWidth);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [heights, gridItems] = useMemo<[number[], GridItem[]]>(() => {
    const heights = new Array(columns).fill(0);
    const gutter = 10;
    const colWidth = columns > 0 ? (Math.max(0, width - gutter * (columns + 1)) / columns) : 0;
    const computeHeight = (child: MasonryItem): number => {
      if (!colWidth) return child.height;
      if (child?.metadata?.provider === 'youtube') {
        return Math.round((colWidth) * 9 / 16);
      }
      if (child?.metadata?.item_type === 'add') {
        return 216;
      }
      if (child?.metadata?.item_type === 'url') {
        // Prefer measured height if available so cards expand with content
        const key = String(child.id);
        const measured = measuredHeights[key];
        if (typeof measured === 'number' && measured > 0) {
          // Add a small safety padding to avoid clipping shadows/borders
          return Math.ceil(measured + 8);
        }
        // Fallback heuristic if not yet measured
        const hasImage = Boolean(child?.metadata?.preview_image);
        const textBase = 24 /* padding */ + 18 /* host line */ + 40 /* title lines */ + 10 /* padding */;
        const imageH = hasImage ? 84 + 8 /* gap */ : 0;
        return textBase + imageH;
      }
      // fallback for notes
      return Math.max(148, Math.min(360, child.height || 220));
    };
    const gridItems = data.map((child) => {
      const column = heights.indexOf(Math.min(...heights));
      const x = gutter + column * (colWidth + gutter);
      const y = heights[column] === 0 ? gutter : heights[column];
      const h = computeHeight(child);
      heights[column] = y + h + gutter;
      return {
        ...child,
        x,
        y,
        width: colWidth,
        height: h,
      };
    });
    return [heights, gridItems];
  }, [columns, data, width, measuredHeights]);

  const transitions = useTransition(
    gridItems,
    {
      keys: (item: GridItem) => item.id,
      from: ({ x, y, width, height }: GridItem) => ({ x, y, width, height, opacity: 0 }),
      enter: ({ x, y, width, height }: GridItem) => ({ x, y, width, height, opacity: 1 }),
      update: ({ x, y, width, height }: GridItem) => ({ x, y, width, height }),
      leave: { height: 0, opacity: 0 },
      config: { mass: 5, tension: 500, friction: 100 },
      trail: 25,
    }
  );

  return (
    <div ref={ref} className="masonry" style={{ height: Math.max(...heights, 0) + 16 }}>
      {transitions((style, item) => {
        const isSelected = selectedId != null && String(selectedId) === String(item.id);
        const isAddCard = item?.metadata?.item_type === 'add';
        const hasImage = Boolean(item.image);
        const noteExcerpt = typeof item.content === 'string' ? item.content.trim() : '';
        return (
        <a.div
          key={item.id}
          style={style}
          className={`masonry-card${isSelected ? ' is-selected' : ''}${isAddCard ? ' is-add-card' : ''}${!hasImage ? ' no-media' : ''}`}
          data-testid="masonry-card"
          data-item-id={String(item.id)}
        >
          {isAddCard ? (
            <button
              type="button"
              className="masonry-add-card"
              onClick={(e) => {
                e.stopPropagation();
                onCardClick?.(item);
              }}
            >
              <span className="masonry-add-icon"><PlusIcon className="masonry-action-icon" /></span>
              <span className="masonry-add-title">{item.title}</span>
              <span className="masonry-add-copy">{noteExcerpt}</span>
            </button>
          ) : (
            <div
              className="masonry-card-bg"
              onClick={(e) => {
                e.stopPropagation();
                onCardClick?.(item);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onCardClick?.(item);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Open item ${item.title || item.id}`}
              style={{
                backgroundImage: hasImage ? `url(${item.image})` : undefined,
                touchAction: 'manipulation',
                WebkitTouchCallout: 'none',
                cursor: 'pointer'
              }}
            />
          )}
          {!isAddCard && !hasImage && item?.metadata?.item_type !== 'url' && (
            <button
              type="button"
              className="masonry-note-preview"
              onClick={(e) => {
                e.stopPropagation();
                onCardClick?.(item);
              }}
            >
              <span className="masonry-note-mark">"</span>
              <span className="masonry-note-text">{noteExcerpt || item.title}</span>
              <span className="masonry-note-title">{item.title}</span>
            </button>
          )}
          <div className={`masonry-card-overlay ${alwaysShowOverlay ? 'always-on' : ''}`} aria-hidden={false}>
            {item?.metadata?.provider === 'youtube' && (
              <div className="masonry-card-play" aria-label="YouTube video" title="YouTube video"><PlayIcon className="masonry-icon" /></div>
            )}
            {!isAddCard && hasImage && item?.metadata?.item_type !== 'url' && typeof item.title === 'string' && item.title.length > 0 && (
              <div className="masonry-card-title" title={item.title}>{item.title}</div>
            )}
            {!isAddCard && item?.metadata?.item_type === 'url' && item?.metadata?.provider !== 'youtube' && (
              <div
                className="masonry-link-preview"
                ref={(el) => {
                  const key = String(item.id);
                  // Clean up any previous observer for this id
                  const prev = observersRef.current.get(key);
                  if (prev) {
                    prev.disconnect();
                    observersRef.current.delete(key);
                  }
                  if (el) {
                    // Measure immediately
                    const measure = () => {
                      const rect = el.getBoundingClientRect();
                      if (rect.height > 0) {
                        setMeasuredHeights((m) => {
                          const curr = m[key];
                          const next = rect.height;
                          // Avoid unnecessary renders
                          if (typeof curr === 'number' && Math.abs(curr - next) < 0.5) return m;
                          return { ...m, [key]: next };
                        });
                      }
                    };
                    measure();
                    // Observe size changes due to content/wrapping
                    const ro = new ResizeObserver(() => measure());
                    ro.observe(el);
                    observersRef.current.set(key, ro);
                  }
                }}
              >
                <div className="mlp-host">
                  {(() => { const fav = faviconForUrl(item?.metadata?.url); return fav ? <img src={fav} alt="" /> : null; })()}
                  <span>{(() => { try { return new URL(item?.metadata?.url || '').hostname; } catch { return 'link'; } })()}</span>
                </div>
                {item?.metadata?.preview_image && (
                  <div className="mlp-media">
                    <img src={item.metadata.preview_image} alt="" />
                  </div>
                )}
                <div className="mlp-title" title={item.title || item?.metadata?.preview_title || item?.metadata?.url}>{item.title || item?.metadata?.preview_title || item?.metadata?.url}</div>
                {item?.metadata?.preview_description && (
                  <div className="mlp-desc" title={item.metadata.preview_description}>{item.metadata.preview_description}</div>
                )}
              </div>
            )}
            {!isAddCard && actionsMode === 'buttons' ? (
              <div className="masonry-card-actions">
                {onMoveItem && (
                  <>
                    <button
                      className="card-action"
                      title="Move up"
                      aria-label="Move up"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMoveItem(item, "up");
                      }}
                      style={{ touchAction: 'manipulation' }}
                    ><ArrowUpIcon className="masonry-action-icon" /></button>
                    <button
                      className="card-action"
                      title="Move down"
                      aria-label="Move down"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMoveItem(item, "down");
                      }}
                      style={{ touchAction: 'manipulation' }}
                    ><ArrowDownIcon className="masonry-action-icon" /></button>
                  </>
                )}
                {onDeleteItem && (
                  <button
                    className="card-action danger"
                    title="Delete"
                    aria-label="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteItem(item);
                    }}
                    style={{ touchAction: 'manipulation' }}
                  ><TrashIcon className="masonry-action-icon" /></button>
                )}
              </div>
            ) : !isAddCard ? (
              <>
                {(onMoveItem || onDeleteItem) && (
                  <div className="masonry-card-menuWrap">
                    <button
                      className="masonry-card-menuBtn"
                      aria-haspopup="true"
                      aria-expanded={openMenuFor === item.id}
                      aria-label="Card actions"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuFor(prev => prev === item.id ? null : item.id);
                      }}
                      style={{ touchAction: 'manipulation' }}
                    ><EllipsisVerticalIcon className="masonry-menu-icon" /></button>
                    {openMenuFor === item.id && (
                      <div className="masonry-card-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                        {onMoveItem && (
                          <>
                            <button
                              className="masonry-card-menuItem"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuFor(null);
                                onMoveItem(item, 'up');
                              }}
                              style={{ touchAction: 'manipulation' }}
                            >Move up</button>
                            <button
                              className="masonry-card-menuItem"
                              role="menuitem"
                              onClick={() => {
                                setOpenMenuFor(null);
                                onMoveItem(item, 'down');
                              }}
                              style={{ touchAction: 'manipulation' }}
                            >Move down</button>
                          </>
                        )}
                        {onDeleteItem && (
                          <button
                            className="masonry-card-menuItem danger"
                            role="menuitem"
                            onClick={() => {
                              setOpenMenuFor(null);
                              onDeleteItem(item);
                            }}
                            style={{ touchAction: 'manipulation' }}
                          >Delete</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </a.div>
      )})}
    </div>
  );
};

export default Masonry;
