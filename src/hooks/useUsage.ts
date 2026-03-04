export interface UseUsageResult {
  plan: string;
  status: string;
  isPastDue: boolean;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  isSubscribed: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  resetAt: string | null;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  checkoutLoading: boolean;
  refetch: () => Promise<void>;
  openCheckout: (plan?: "monthly" | "annual") => Promise<{ success: boolean; error?: string }>;
  openBillingPortal: () => Promise<{ success: boolean; error?: string }>;
}

const noop = async () => ({ success: true as const });

export function useUsage(): UseUsageResult {
  return {
    plan: "pro",
    status: "active",
    isPastDue: false,
    wordsUsed: 0,
    wordsRemaining: 999999,
    limit: 999999,
    isSubscribed: true,
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    isOverLimit: false,
    isApproachingLimit: false,
    resetAt: null,
    isLoading: false,
    hasLoaded: true,
    error: null,
    checkoutLoading: false,
    refetch: async () => {},
    openCheckout: noop,
    openBillingPortal: noop,
  };
}
