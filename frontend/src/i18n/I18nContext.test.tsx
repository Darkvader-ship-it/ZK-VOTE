import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { I18nProvider, useTranslation } from "./I18nContext";

describe("I18nContext architecture", () => {
  it("translates keys in English by default", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });
    expect(result.current.t("vote.button")).toBe("Vote Now");
    expect(result.current.dir).toBe("ltr");
  });

  it("switches language and sets RTL direction for Arabic", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("ar");
    });

    expect(result.current.language).toBe("ar");
    expect(result.current.dir).toBe("rtl");
    expect(result.current.t("vote.button")).toBe("صوت الآن");
  });

  it("switches to Spanish correctly", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider>{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLanguage("es");
    });

    expect(result.current.t("vote.button")).toBe("Votar Ahora");
  });
});
