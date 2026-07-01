'use client';

import { useState } from 'react';
import type { PaymentMode } from '@openx/sdk';

/**
 * useConnectedPrivacyMode — owns the public/private tier choice for hire
 * actions. v3.1 makes `'private'` the default so every buyer→agent USDC
 * payment routes through the ZK Privacy Pool envelope unless the buyer
 * explicitly downgrades to public via `PrivacyModeToggle`.
 */
export function useConnectedPrivacyMode() {
  const [mode, setMode] = useState<PaymentMode>('private');
  return { mode, setMode };
}
