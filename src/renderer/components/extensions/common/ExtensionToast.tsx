/**
 * ExtensionToast — lightweight notification system for Extension Store events.
 * Shows success/error/warning/info toasts with secret masking.
 */

import { useCallback, useEffect, useState } from 'react';

import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ExtensionToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

const TOAST_STYLES: Record<
  ToastType,
  { bg: string; border: string; icon: typeof CheckCircle; iconColor: string }
> = {
  success: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    icon: CheckCircle,
    iconColor: 'text-emerald-400',
  },
  error: {
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
  },
  warning: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    icon: AlertTriangle,
    iconColor: 'text-amber-400',
  },
  info: {
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/30',
    icon: Info,
    iconColor: 'text-indigo-400',
  },
};

const AUTO_HIDE_MS: Record<ToastType, number> = {
  success: 3000,
  error: 0,
  warning: 5000,
  info: 4000,
};

export function maskSecrets(text: string): string {
  return text.replace(
    /(?:token|secret|key|password|api[_-]?key|auth|credential)["\s:=]+(["']?)([\w\-./+=]{8,})\1/gi,
    '$1[REDACTED]$1'
  );
}

const ToastItem = ({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) => {
  const style = TOAST_STYLES[toast.type];
  const Icon = style.icon;

  useEffect(() => {
    const ms = AUTO_HIDE_MS[toast.type];
    if (ms > 0) {
      const timer = setTimeout(onDismiss, ms);
      return () => clearTimeout(timer);
    }
  }, [toast.type, onDismiss]);

  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 shadow-lg ${style.bg} ${style.border}`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${style.iconColor}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{toast.title}</p>
        {toast.message && (
          <p className="mt-0.5 text-xs text-text-muted">{maskSecrets(toast.message)}</p>
        )}
      </div>
      <button onClick={onDismiss} className="shrink-0 text-text-muted hover:text-text">
        <X className="size-3.5" />
      </button>
    </div>
  );
};

export const ExtensionToast = ({ toasts, onDismiss }: ExtensionToastProps): React.JSX.Element => {
  if (toasts.length === 0) return <></>;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" style={{ maxWidth: 360 }}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
};

let toastSeq = 0;

export function useExtensionToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = `ext-toast-${++toastSeq}`;
    setToasts((prev) => [...prev, { id, type, title, message }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}

/**
 * StoreExtensionToast — reads toasts from Zustand store (set by install/uninstall/diagnostics).
 * Drop into ExtensionStoreView to show toast notifications.
 */
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

export const StoreExtensionToast = (): React.JSX.Element => {
  const { toasts, dismissToast } = useStore(
    useShallow((s) => ({
      toasts: s.extensionToasts,
      dismissToast: s.dismissExtensionToast,
    }))
  );
  return <ExtensionToast toasts={toasts} onDismiss={dismissToast} />;
};
