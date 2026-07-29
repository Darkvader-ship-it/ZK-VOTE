/**
 * Hardened UI Store
 * DevTools disabled in production builds.
 */

import { configureDevtools } from "./secureStorage";

export interface UIState {
  theme: "light" | "dark" | "system";
  isModalOpen: boolean;
  activeModal: string | null;
}

// Ensure DevTools disabled in production on load
configureDevtools();

let state: UIState = {
  theme: "system",
  isModalOpen: false,
  activeModal: null,
};

const listeners = new Set<() => void>();

export const uiStore = {
  getState: (): UIState => state,

  setTheme: (theme: "light" | "dark" | "system") => {
    state = { ...state, theme };
    listeners.forEach((l) => l());
  },

  openModal: (modalName: string) => {
    state = { ...state, isModalOpen: true, activeModal: modalName };
    listeners.forEach((l) => l());
  },

  closeModal: () => {
    state = { ...state, isModalOpen: false, activeModal: null };
    listeners.forEach((l) => l());
  },

  clearUIStore: () => {
    state = {
      theme: "system",
      isModalOpen: false,
      activeModal: null,
    };
    listeners.forEach((l) => l());
  },

  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
