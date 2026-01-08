declare module '*.jsx' { const component: React.FC<Record<string, unknown>>; export default component }
declare module '*.css' { const classes: { [key: string]: string }; export default classes }
declare module '*.module.css' { const classes: { [key: string]: string }; export default classes }
declare module '*.png' { const src: string; export default src }
declare module '*.jpg' { const src: string; export default src }
declare module '*.jpeg' { const src: string; export default src }
declare module '*.svg' { const src: string; export default src }
declare module '*.ico' { const src: string; export default src }

// Clipboard API type augmentation for clipboard.read()
interface ClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

interface Clipboard {
  read(): Promise<ClipboardItem[]>;
}
