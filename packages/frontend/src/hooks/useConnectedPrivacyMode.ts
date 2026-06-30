'use client';

import { useState } from 'react';
import type { PaymentMode } from '@openx/sdk';

/**
 * useConnectedPrivacyMode — owns the public/private tier choice for hire
 * actions. Default is `public`; the user flips it via `PrivacyModeToggle`.
 */
export function useConnectedPrivacyMode() {
  const [mode, setMode] = useState<PaymentMode>('public');
  return { mode, setMode };
}
