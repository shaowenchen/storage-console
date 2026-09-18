import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { copyToClipboard } from '../format';
import './notice.css';

type NoticeState = {
  open: boolean;
  title: string;
  message: string;
  variant: 'notice' | 'error';
};

type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
};

type ToastVariant = 'success' | 'error';

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
};

type NoticeContextValue = {
  notify: (message: string, title?: string) => void;
  notifyError: (message: string, title?: string) => void;
  confirm: (message: string, title?: string) => Promise<boolean>;
  /** Returns a handle for `updateToast`, or null when nothing rendered it. */
  toast: (message: string, variant?: ToastVariant) => number | null;
  updateToast: (id: number, message: string, variant?: ToastVariant) => void;
};

const NoticeContext = createContext<NoticeContextValue | null>(null);

const ERROR_NOTICE_COOLDOWN_MS = 30000;
const TOAST_DURATION_MS = 2600;
const recentErrorNotices = new Map<string, number>();

let externalNotify: NoticeContextValue['notify'] | null = null;
let externalNotifyError: NoticeContextValue['notifyError'] | null = null;
let externalConfirm: NoticeContextValue['confirm'] | null = null;
let externalToast: NoticeContextValue['toast'] | null = null;
let externalUpdateToast: NoticeContextValue['updateToast'] | null = null;

function errorNoticeKey(title: string, message: string): string {
  return `${title}\0${message}`;
}

export function notify(message: string, title = 'Notice') {
  if (externalNotify) {
    externalNotify(message, title);
    return;
  }
  console.warn(`[notice] ${title}: ${message}`);
}

export function notifyError(message: string, title = 'Error') {
  const key = errorNoticeKey(title, message);
  const now = Date.now();
  const lastShown = recentErrorNotices.get(key);
  if (lastShown && now - lastShown < ERROR_NOTICE_COOLDOWN_MS) return;
  recentErrorNotices.set(key, now);

  if (externalNotifyError) {
    externalNotifyError(message, title);
    return;
  }
  console.warn(`[notice] ${title}: ${message}`);
}

export async function confirm(message: string, title = 'Confirm'): Promise<boolean> {
  if (externalConfirm) {
    return externalConfirm(message, title);
  }
  return window.confirm(message);
}

/**
 * Transient confirmation for fire-and-forget actions (copying a link, say).
 * Unlike `notify` it needs no dismissal, so keep it to messages the user does
 * not have to read — anything they may need to copy still belongs in a modal.
 *
 * Returns a handle for `updateToast`, which is how a longer operation reports
 * progress without stacking a toast per step.
 */
export function toast(message: string, variant: ToastVariant = 'success'): number | null {
  if (externalToast) {
    return externalToast(message, variant);
  }
  console.warn(`[toast] ${message}`);
  return null;
}

/** Replaces the text of a live toast, restarting its dismissal timer. */
export function updateToast(id: number | null, message: string, variant?: ToastVariant) {
  if (id === null || !externalUpdateToast) return;
  externalUpdateToast(id, message, variant);
}

export function AppNoticeProvider({ children }: { children: ReactNode }) {
  const [noticeState, setNoticeState] = useState<NoticeState>({
    open: false,
    title: 'Notice',
    message: '',
    variant: 'notice',
  });
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    title: 'Confirm',
    message: '',
  });
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toastFn = useCallback(
    (message: string, variant: ToastVariant = 'success') => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev, { id, message, variant }]);
      toastTimersRef.current.set(
        id,
        setTimeout(() => dismissToast(id), TOAST_DURATION_MS),
      );
      return id;
    },
    [dismissToast],
  );

  const updateToastFn = useCallback(
    (id: number, message: string, variant?: ToastVariant) => {
      setToasts((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, message, variant: variant ?? item.variant } : item,
        ),
      );
      // Restart the countdown: a progress toast should linger after its last
      // update, not vanish mid-operation.
      const existing = toastTimersRef.current.get(id);
      if (existing) clearTimeout(existing);
      toastTimersRef.current.set(
        id,
        setTimeout(() => dismissToast(id), TOAST_DURATION_MS),
      );
    },
    [dismissToast],
  );

  useEffect(() => {
    const timers = toastTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const notifyFn = useCallback((message: string, title = 'Notice') => {
    setCodeCopied(false);
    setNoticeState({ open: true, title, message, variant: 'notice' });
  }, []);

  const notifyErrorFn = useCallback((message: string, title = 'Error') => {
    setCodeCopied(false);
    setNoticeState({ open: true, title, message, variant: 'error' });
  }, []);

  const confirmFn = useCallback((message: string, title = 'Confirm') => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmState({ open: true, title, message });
    });
  }, []);

  const value = useMemo(
    () => ({
      notify: notifyFn,
      notifyError: notifyErrorFn,
      confirm: confirmFn,
      toast: toastFn,
      updateToast: updateToastFn,
    }),
    [notifyFn, notifyErrorFn, confirmFn, toastFn, updateToastFn],
  );

  externalNotify = notifyFn;
  externalNotifyError = notifyErrorFn;
  externalConfirm = confirmFn;
  externalToast = toastFn;
  externalUpdateToast = updateToastFn;

  const noticeParts = splitNoticeMessage(noticeState.message);
  const confirmParts = splitNoticeMessage(confirmState.message);

  function closeNotice() {
    setCodeCopied(false);
    setNoticeState((prev) => ({ ...prev, open: false }));
  }

  async function copyNoticeCode() {
    if (!noticeParts.code) return;
    const ok = await copyToClipboard(noticeParts.code);
    setCodeCopied(ok);
  }

  function resolveConfirm(accepted: boolean) {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState((prev) => ({ ...prev, open: false }));
    if (resolve) resolve(accepted);
  }

  return (
    <NoticeContext.Provider value={value}>
      {children}
      {noticeState.open ? (
        <div className="app-notice-overlay" role="presentation" onClick={closeNotice}>
          <div
            className={[
              'app-notice-card',
              noticeState.variant === 'error' ? 'app-notice-error' : '',
              noticeParts.code ? 'app-notice-card-wide' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-notice-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="app-notice-header">
              <h2 id="app-notice-title">{noticeState.title}</h2>
              <button
                type="button"
                className="app-notice-close"
                aria-label="Close"
                onClick={closeNotice}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4L4 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            {noticeParts.text ? <p className="app-notice-message">{noticeParts.text}</p> : null}
            {noticeParts.code ? (
              <div className="app-notice-code-block">
                <pre className="app-notice-code">{noticeParts.code}</pre>
              </div>
            ) : null}
            <div
              className={`app-notice-actions${noticeParts.code ? ' app-notice-actions-split' : ''}`}
            >
              {noticeParts.code ? (
                <>
                  <button type="button" className="ghost-btn" onClick={closeNotice}>
                    Close
                  </button>
                  <button type="button" className="primary" onClick={() => void copyNoticeCode()}>
                    {codeCopied ? 'Copied' : 'Copy'}
                  </button>
                </>
              ) : (
                <button type="button" className="primary" onClick={closeNotice}>
                  OK
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {confirmState.open ? (
        <div
          className="app-notice-overlay"
          role="presentation"
          onClick={() => resolveConfirm(false)}
        >
          <div
            className={['app-notice-card', confirmParts.code ? 'app-notice-card-wide' : '']
              .filter(Boolean)
              .join(' ')}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="app-confirm-title">{confirmState.title}</h2>
            {confirmParts.text ? <p className="app-notice-message">{confirmParts.text}</p> : null}
            {confirmParts.code ? <pre className="app-notice-code">{confirmParts.code}</pre> : null}
            <div className="app-notice-actions app-notice-actions-split">
              <button type="button" className="ghost-btn" onClick={() => resolveConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => resolveConfirm(true)}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toasts.length ? (
        <div
          className="app-toast-stack"
          // The CSS timer bar drains over exactly the JS dismissal delay, so the
          // two cannot drift apart.
          style={{ '--app-toast-duration': `${TOAST_DURATION_MS}ms` } as CSSProperties}
        >
          {toasts.map((item) => (
            <div
              key={item.id}
              className={`app-toast ${item.variant === 'error' ? 'app-toast-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              <span className="app-toast-icon" aria-hidden="true">
                {item.variant === 'error' ? <ErrorGlyph /> : <SuccessGlyph />}
              </span>
              <span className="app-toast-message">{item.message}</span>
              <button
                type="button"
                className="app-toast-close"
                aria-label="Dismiss"
                onClick={() => dismissToast(item.id)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4L4 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              {/* Keyed on the message so a progress update restarts the drain. */}
              <span className="app-toast-timer" key={item.message} aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : null}
    </NoticeContext.Provider>
  );
}

/** Status glyphs for the toast cards, drawn inline to avoid an icon dependency. */
function SuccessGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.3 8.2l1.9 1.9 3.5-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ErrorGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 4.7v3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.2" r="0.85" fill="currentColor" />
    </svg>
  );
}

function splitNoticeMessage(message: string): { text: string; code: string } {
  const trimmed = String(message || '');
  const idx = trimmed.indexOf('\n');
  if (idx === -1) return { text: trimmed, code: '' };
  const text = trimmed.slice(0, idx).trim();
  const rest = trimmed.slice(idx + 1).trim();
  const looksLikeCode = /^(export |curl |https?:\/\/|FILE_PATH=|STORAGE_CONSOLE_)/m.test(rest);
  if (!looksLikeCode) return { text: trimmed, code: '' };
  return { text, code: rest };
}

export function useAppNotice(): NoticeContextValue {
  const ctx = useContext(NoticeContext);
  if (!ctx) {
    throw new Error('useAppNotice must be used within AppNoticeProvider');
  }
  return ctx;
}
