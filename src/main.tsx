import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import '../styles/tokens.css'; // Import global tokens
import '../styles/fonts.css'; // Import font imports and utilities
import '../styles/global.css'; // Import global base styles
import '../styles/themes/dark.css'; // Import dark theme overrides
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { HotkeyProvider } from "./contexts/HotkeyContext";
import { ConfirmProvider } from "./contexts/ConfirmContext";
import { VaultPasswordProvider } from "./contexts/VaultPasswordContext";
import { PromptProvider } from "./contexts/PromptContext";
import ErrorBoundary from "./components/ErrorBoundary/ErrorBoundary";
// System tray handled in Rust (see src-tauri/src/lib.rs)

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HotkeyProvider>
        <ThemeProvider>
          <ToastProvider>
            <PromptProvider>
              <VaultPasswordProvider>
                <ConfirmProvider>
                  <App />
                </ConfirmProvider>
              </VaultPasswordProvider>
            </PromptProvider>
          </ToastProvider>
        </ThemeProvider>
      </HotkeyProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
