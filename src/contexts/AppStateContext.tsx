import React, { createContext, useContext, useReducer, ReactNode, useCallback } from 'react';
import { Vault, VaultItem, SearchResult, AppView, ProtocolCapture } from '../types';

// State interface
interface AppState {
  // UI State
  currentView: AppView;
  isCaptureModalOpen: boolean;
  isCreateVaultModalOpen: boolean;
  isItemBusy: boolean;
  
  // Data State
  vaults: Vault[];
  selectedVaultId: string | null;
  vaultItems: VaultItem[];
  isLoadingVaultItems: boolean;
  selectedItem: VaultItem | null;
  
  // Search State
  searchQuery: string;
  isSearching: boolean;
  searchCards: SearchResult[];
  searchSelectedItem: VaultItem | null;
  
  // Protocol State
  protocolCapture: ProtocolCapture | null;
  pendingOpenItemId: string | null;
  
  // Cover Dialog State
  coverVault: { id: string; title: string } | null;
}

// Action types
type AppAction =
  | { type: 'SET_CURRENT_VIEW'; payload: AppView }
  | { type: 'SET_CAPTURE_MODAL_OPEN'; payload: boolean }
  | { type: 'SET_CREATE_VAULT_MODAL_OPEN'; payload: boolean }
  | { type: 'SET_ITEM_BUSY'; payload: boolean }
  | { type: 'SET_VAULTS'; payload: Vault[] }
  | { type: 'SET_SELECTED_VAULT_ID'; payload: string | null }
  | { type: 'SET_VAULT_ITEMS'; payload: VaultItem[] }
  | { type: 'SET_LOADING_VAULT_ITEMS'; payload: boolean }
  | { type: 'SET_SELECTED_ITEM'; payload: VaultItem | null }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_IS_SEARCHING'; payload: boolean }
  | { type: 'SET_SEARCH_CARDS'; payload: SearchResult[] }
  | { type: 'SET_SEARCH_SELECTED_ITEM'; payload: VaultItem | null }
  | { type: 'SET_PROTOCOL_CAPTURE'; payload: ProtocolCapture | null }
  | { type: 'SET_PENDING_OPEN_ITEM_ID'; payload: string | null }
  | { type: 'SET_COVER_VAULT'; payload: { id: string; title: string } | null }
  | { type: 'ADD_VAULT_ITEM'; payload: VaultItem }
  | { type: 'UPDATE_VAULT_ITEM'; payload: { id: string; updates: Partial<VaultItem> } }
  | { type: 'REMOVE_VAULT_ITEM'; payload: string }
  | { type: 'RESET_SEARCH'; payload: undefined };

// Initial state
const initialState: AppState = {
  currentView: 'vaults',
  isCaptureModalOpen: false,
  isCreateVaultModalOpen: false,
  isItemBusy: false,
  vaults: [],
  selectedVaultId: null,
  vaultItems: [],
  isLoadingVaultItems: false,
  selectedItem: null,
  searchQuery: '',
  isSearching: false,
  searchCards: [],
  searchSelectedItem: null,
  protocolCapture: null,
  pendingOpenItemId: null,
  coverVault: null,
};

// Reducer function
function appStateReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CURRENT_VIEW':
      return { ...state, currentView: action.payload };
    
    case 'SET_CAPTURE_MODAL_OPEN':
      return { ...state, isCaptureModalOpen: action.payload };
    
    case 'SET_CREATE_VAULT_MODAL_OPEN':
      return { ...state, isCreateVaultModalOpen: action.payload };
    
    case 'SET_ITEM_BUSY':
      return { ...state, isItemBusy: action.payload };
    
    case 'SET_VAULTS':
      return { ...state, vaults: action.payload };
    
    case 'SET_SELECTED_VAULT_ID':
      return { 
        ...state, 
        selectedVaultId: action.payload,
        // Reset vault items when changing vaults
        vaultItems: action.payload !== state.selectedVaultId ? [] : state.vaultItems,
        selectedItem: action.payload !== state.selectedVaultId ? null : state.selectedItem
      };
    
    case 'SET_VAULT_ITEMS':
      return { ...state, vaultItems: action.payload };
    
    case 'SET_LOADING_VAULT_ITEMS':
      return { ...state, isLoadingVaultItems: action.payload };
    
    case 'SET_SELECTED_ITEM':
      return { ...state, selectedItem: action.payload };
    
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };
    
    case 'SET_IS_SEARCHING':
      return { ...state, isSearching: action.payload };
    
    case 'SET_SEARCH_CARDS':
      return { ...state, searchCards: action.payload };
    
    case 'SET_SEARCH_SELECTED_ITEM':
      return { ...state, searchSelectedItem: action.payload };
    
    case 'SET_PROTOCOL_CAPTURE':
      return { ...state, protocolCapture: action.payload };
    
    case 'SET_PENDING_OPEN_ITEM_ID':
      return { ...state, pendingOpenItemId: action.payload };
    
    case 'SET_COVER_VAULT':
      return { ...state, coverVault: action.payload };
    
    case 'ADD_VAULT_ITEM':
      return { 
        ...state, 
        vaultItems: [...state.vaultItems, action.payload] 
      };
    
    case 'UPDATE_VAULT_ITEM':
      return {
        ...state,
        vaultItems: state.vaultItems.map(item =>
          item.id === action.payload.id
            ? { ...item, ...action.payload.updates }
            : item
        ),
        selectedItem: state.selectedItem?.id === action.payload.id
          ? { ...state.selectedItem, ...action.payload.updates }
          : state.selectedItem
      };
    
    case 'REMOVE_VAULT_ITEM':
      return {
        ...state,
        vaultItems: state.vaultItems.filter(item => item.id !== action.payload),
        selectedItem: state.selectedItem?.id === action.payload ? null : state.selectedItem
      };
    
    case 'RESET_SEARCH':
      return {
        ...state,
        searchQuery: '',
        searchCards: [],
        searchSelectedItem: null,
        isSearching: false
      };
    
    default:
      return state;
  }
}

// Context interface
interface AppStateContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  
  // Convenience action creators
  setCurrentView: (view: AppView) => void;
  openCaptureModal: () => void;
  closeCaptureModal: () => void;
  openCreateVaultModal: () => void;
  closeCreateVaultModal: () => void;
  setVaults: (vaults: Vault[]) => void;
  selectVault: (vaultId: string | null) => void;
  setVaultItems: (items: VaultItem[]) => void;
  selectItem: (item: VaultItem | null) => void;
  addVaultItem: (item: VaultItem) => void;
  updateVaultItem: (id: string, updates: Partial<VaultItem>) => void;
  removeVaultItem: (id: string) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: SearchResult[]) => void;
  resetSearch: () => void;
  setProtocolCapture: (capture: ProtocolCapture | null) => void;
}

// Create context
const AppStateContext = createContext<AppStateContextType | undefined>(undefined);

// Provider component
interface AppStateProviderProps {
  children: ReactNode;
}

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(appStateReducer, initialState);

  // Convenience action creators
  const setCurrentView = useCallback((view: AppView) => {
    dispatch({ type: 'SET_CURRENT_VIEW', payload: view });
  }, []);

  const openCaptureModal = useCallback(() => {
    dispatch({ type: 'SET_CAPTURE_MODAL_OPEN', payload: true });
  }, []);

  const closeCaptureModal = useCallback(() => {
    dispatch({ type: 'SET_CAPTURE_MODAL_OPEN', payload: false });
    dispatch({ type: 'SET_PROTOCOL_CAPTURE', payload: null });
  }, []);

  const openCreateVaultModal = useCallback(() => {
    dispatch({ type: 'SET_CREATE_VAULT_MODAL_OPEN', payload: true });
  }, []);

  const closeCreateVaultModal = useCallback(() => {
    dispatch({ type: 'SET_CREATE_VAULT_MODAL_OPEN', payload: false });
  }, []);

  const setVaults = useCallback((vaults: Vault[]) => {
    dispatch({ type: 'SET_VAULTS', payload: vaults });
  }, []);

  const selectVault = useCallback((vaultId: string | null) => {
    dispatch({ type: 'SET_SELECTED_VAULT_ID', payload: vaultId });
  }, []);

  const setVaultItems = useCallback((items: VaultItem[]) => {
    dispatch({ type: 'SET_VAULT_ITEMS', payload: items });
  }, []);

  const selectItem = useCallback((item: VaultItem | null) => {
    dispatch({ type: 'SET_SELECTED_ITEM', payload: item });
  }, []);

  const addVaultItem = useCallback((item: VaultItem) => {
    dispatch({ type: 'ADD_VAULT_ITEM', payload: item });
  }, []);

  const updateVaultItem = useCallback((id: string, updates: Partial<VaultItem>) => {
    dispatch({ type: 'UPDATE_VAULT_ITEM', payload: { id, updates } });
  }, []);

  const removeVaultItem = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_VAULT_ITEM', payload: id });
  }, []);

  const setSearchQuery = useCallback((query: string) => {
    dispatch({ type: 'SET_SEARCH_QUERY', payload: query });
  }, []);

  const setSearchResults = useCallback((results: SearchResult[]) => {
    dispatch({ type: 'SET_SEARCH_CARDS', payload: results });
  }, []);

  const resetSearch = useCallback(() => {
    dispatch({ type: 'RESET_SEARCH', payload: undefined });
  }, []);

  const setProtocolCapture = useCallback((capture: ProtocolCapture | null) => {
    dispatch({ type: 'SET_PROTOCOL_CAPTURE', payload: capture });
  }, []);

  const contextValue: AppStateContextType = {
    state,
    dispatch,
    setCurrentView,
    openCaptureModal,
    closeCaptureModal,
    openCreateVaultModal,
    closeCreateVaultModal,
    setVaults,
    selectVault,
    setVaultItems,
    selectItem,
    addVaultItem,
    updateVaultItem,
    removeVaultItem,
    setSearchQuery,
    setSearchResults,
    resetSearch,
    setProtocolCapture,
  };

  return (
    <AppStateContext.Provider value={contextValue}>
      {children}
    </AppStateContext.Provider>
  );
};

// Custom hook
export const useAppState = (): AppStateContextType => {
  const context = useContext(AppStateContext);
  if (context === undefined) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return context;
};