/**
 * TWAP Plugin for Orderly SDK v3
 *
 * Interceptors:
 *  1. Trading.OrderEntry.TypeTabs — adds TWAP button below order type tabs
 *  2. OrderEntry — replaces entire form when TWAP is active
 */

import React from "react";
import { TypeTabsInterceptor, OrderEntryInterceptor } from "./TwapSection";
import type { OrderlyPlugin } from "@orderly.network/ui";

export const twapPlugin: OrderlyPlugin = {
  id: "orderly-twap-plugin",
  name: "TWAP Strategy",
  version: "1.0.0",
  interceptors: [
    {
      target: "Trading.OrderEntry.TypeTabs",
      component: (Original, props, api) => {
        return React.createElement(TypeTabsInterceptor, { Original, props });
      },
    },
    {
      target: "OrderEntry",
      component: (Original, props, api) => {
        return React.createElement(OrderEntryInterceptor, { Original, props });
      },
    },
  ],
};
