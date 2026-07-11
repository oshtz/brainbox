import * as React from 'react';
type VaultOpt = { id: string; title: string };
interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { title: string; content: string; vaultId: string }) => void;
  vaults?: VaultOpt[];
  initialVaultId?: string;
  initialVaultId?: string;
  initialTitle?: string;
  initialContent?: string;
}
declare const CaptureModal: React.FC<Props>;
export default CaptureModal;

