import { useState, useRef, useEffect, type ReactNode } from 'react';

export interface OverflowAction {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  confirmText?: string;
}

interface Props {
  actions: OverflowAction[];
  label?: ReactNode;
}

export default function OverflowMenu({ actions, label = '\u22EF' }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPendingConfirm(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="overflow-menu" ref={ref}>
      <button
        className="btn small ghost overflow-menu-trigger"
        onClick={() => { setOpen((v) => !v); setPendingConfirm(null); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
      >
        {label}
      </button>
      {open && (
        <div className="overflow-menu-panel" role="menu">
          {actions.map((a, i) => {
            const isPending = pendingConfirm === i;
            const onClick = () => {
              if (a.disabled) return;
              if (a.confirmText && !isPending) {
                setPendingConfirm(i);
                return;
              }
              a.onClick?.();
              setOpen(false);
              setPendingConfirm(null);
            };
            return (
              <button
                key={`${a.label}-${i}`}
                className={`overflow-menu-item ${a.danger ? 'danger' : ''} ${a.disabled ? 'disabled' : ''} ${isPending ? 'confirm' : ''}`}
                role="menuitem"
                disabled={a.disabled}
                title={a.title}
                onClick={onClick}
              >
                {isPending ? a.confirmText : a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
