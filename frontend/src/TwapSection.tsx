/**
 * TWAP interceptor components.
 *
 * TypeTabsInterceptor: renders Original tabs + injects TWAP into Advanced dropdown via DOM
 * OrderEntryInterceptor: replaces the form when TWAP mode is active
 *
 * Shared state via module-level store + useSyncExternalStore.
 */

import React, { useSyncExternalStore, useEffect, useRef, useCallback } from "react";
import { TwapForm } from "./TwapForm";

// ─── Shared TWAP mode state ───────────────────────────────

let _twapActive = false;
let _currentSymbol = "";
const _listeners = new Set<() => void>();

function setTwapActive(active: boolean) {
  _twapActive = active;
  _listeners.forEach((fn) => fn());
}

function setCurrentSymbol(sym: string) {
  _currentSymbol = sym;
}

function subscribe(fn: () => void) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function useTwapActive() {
  return useSyncExternalStore(subscribe, () => _twapActive);
}

// ─── TypeTabs Interceptor ─────────────────────────────────
// Renders the original TypeTabs, then uses MutationObserver to inject
// a "TWAP" option into the Advanced dropdown when it opens.

interface TypeTabsInterceptorProps {
  Original: React.ComponentType<any>;
  props: any;
}

export function TypeTabsInterceptor({ Original, props }: TypeTabsInterceptorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const twapActive = useTwapActive();

  const injectTwapOption = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Find dropdown menu items (the popover/select options)
    // The SDK uses a Select component; look for the options container
    const root = document.body;
    const allOptions = root.querySelectorAll('[role="option"], [data-radix-collection-item]');

    // Find the last option (Trailing stop) to insert after it
    let lastOptionEl: Element | null = null;
    allOptions.forEach((el) => {
      const text = el.textContent?.trim() || "";
      if (
        text.includes("Trailing") ||
        text.includes("trailing") ||
        text.includes("Scaled") ||
        text.includes("scaled")
      ) {
        lastOptionEl = el;
      }
    });

    if (!lastOptionEl) return;
    const lastOption = lastOptionEl as HTMLElement;

    // Check if TWAP already injected
    const parent = lastOption.parentElement;
    if (!parent || parent.querySelector('[data-twap-option]')) return;

    // Clone the style of an existing option
    const twapEl = lastOption.cloneNode(true) as HTMLElement;
    twapEl.setAttribute("data-twap-option", "true");
    twapEl.textContent = "TWAP";
    twapEl.style.cursor = "pointer";

    twapEl.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      setTwapActive(true);
      // Close the dropdown by clicking outside
      document.body.click();
    });

    parent.appendChild(twapEl);
  }, []);

  // Watch for dropdown opening
  useEffect(() => {
    const observer = new MutationObserver(() => {
      // Small delay to let dropdown render
      setTimeout(injectTwapOption, 50);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [injectTwapOption]);

  // When TWAP is active, show an indicator on the tabs
  if (twapActive) {
    return (
      <div>
        <div style={S.twapActiveBar}>
          <span style={S.twapActiveLabel}>TWAP</span>
          <button
            type="button"
            onClick={() => setTwapActive(false)}
            style={S.twapExitBtn}
          >
            Exit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <Original {...props} />
    </div>
  );
}

// ─── OrderEntry Interceptor ───────────────────────────────

interface OrderEntryInterceptorProps {
  Original: React.ComponentType<any>;
  props: any;
}

export function OrderEntryInterceptor({ Original, props }: OrderEntryInterceptorProps) {
  const twapActive = useTwapActive();

  // Try to extract symbol from props
  const symbol = props?.symbol || _currentSymbol || "PERP_ETH_USDC";
  if (props?.symbol && props.symbol !== _currentSymbol) {
    setCurrentSymbol(props.symbol);
  }

  if (twapActive) {
    return <TwapForm symbol={symbol} onBack={() => setTwapActive(false)} />;
  }

  return <Original {...props} />;
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  twapActiveBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(124, 92, 252, 0.1)",
    border: "1px solid rgba(124, 92, 252, 0.3)",
  },
  twapActiveLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#7c5cfc",
  },
  twapExitBtn: {
    fontSize: 11,
    padding: "4px 12px",
    borderRadius: 4,
    border: "1px solid rgba(124, 92, 252, 0.3)",
    background: "transparent",
    color: "#7c5cfc",
    cursor: "pointer",
  },
};
