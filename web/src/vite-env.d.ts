/// <reference types="vite/client" />

interface StorageConsoleConfig {
  routePrefix: string;
}

interface Window {
  __STORAGE_CONSOLE_CONFIG__?: StorageConsoleConfig;
}
