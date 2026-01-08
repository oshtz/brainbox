import * as React from "react";
export interface MasonryItem {
  id: string | number;
  height: number;
  image: string;
  title?: string;
  [key: string]: unknown;
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
declare const Masonry: React.FC<MasonryProps>;
export default Masonry;
