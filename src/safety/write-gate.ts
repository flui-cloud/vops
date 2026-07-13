export type BillingModel = 'hourly' | 'monthly' | 'mixed' | 'unknown';

export interface WriteGate {
  writeEnabled: boolean;
  writeDisabledReason: string | null;
}

/**
 * The single source of truth for the vops safety policy: vops only *provisions*
 * on hourly-billed providers. Non-hourly providers are never auto-provisioned
 * (that would place a monthly commitment) — they are shown as "guided" instead.
 */
export function computeWriteGate(billingModel: BillingModel): WriteGate {
  if (billingModel === 'hourly') {
    return { writeEnabled: true, writeDisabledReason: null };
  }
  return {
    writeEnabled: false,
    writeDisabledReason:
      `vops does not provision '${billingModel}'-billed providers ` +
      `(monthly commitment). It shows how to create instead.`,
  };
}
