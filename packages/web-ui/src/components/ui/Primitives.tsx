import React, { useEffect, useId, useRef } from 'react';

export interface CrtWindowFrameProps {
  title: string;
  variant?: 'default' | 'elevated' | 'magenta';
  active?: boolean;
  fill?: boolean;
  flushBody?: boolean;
  headerRight?: React.ReactNode;
  statusBarLeft?: React.ReactNode;
  statusBarRight?: React.ReactNode;
  children: React.ReactNode;
}

export function CrtWindowFrame({
  title,
  variant = 'default',
  active = false,
  fill = false,
  flushBody = false,
  headerRight,
  statusBarLeft,
  statusBarRight,
  children,
}: CrtWindowFrameProps): React.ReactElement {
  const classes = [
    'crt-window',
    variant === 'elevated' ? 'crt-window--elevated' : '',
    variant === 'magenta' ? 'crt-window--magenta-bar' : '',
    active ? 'crt-window--active' : '',
    fill ? 'crt-window--fill' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes}>
      <header className="crt-window__titlebar">
        <div className="crt-window__title-left">
          <span className="crt-window__dots" aria-hidden="true">
            <span className="crt-dot crt-dot--magenta" />
            <span className="crt-dot crt-dot--cyan" />
            <span className="crt-dot crt-dot--violet" />
          </span>
          <h2 className="crt-window__title">{title}</h2>
        </div>
        {headerRight ? <div>{headerRight}</div> : null}
      </header>
      <div className={flushBody ? 'crt-window__body crt-window__body--flush' : 'crt-window__body'}>
        {children}
      </div>
      {statusBarLeft || statusBarRight ? (
        <footer className="crt-window__statusbar">
          <span>{statusBarLeft}</span>
          <span>{statusBarRight}</span>
        </footer>
      ) : null}
    </section>
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'cyan' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  fullWidth?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps): React.ReactElement {
  const classes = [
    'ui-btn',
    variant === 'primary' ? 'ui-btn--primary' : '',
    variant === 'cyan' ? 'ui-btn--cyan' : '',
    variant === 'ghost' ? 'ui-btn--ghost' : '',
    variant === 'danger' ? 'ui-btn--danger' : '',
    size === 'sm' ? 'ui-btn--sm' : '',
    fullWidth ? 'ui-btn--full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}

export interface SyntaxTagBadgeProps {
  label: string;
  meta?: string;
  tone?: 'cyan' | 'magenta' | 'success' | 'warning' | 'danger' | 'muted';
}

export function SyntaxTagBadge({
  label,
  meta,
  tone = 'cyan',
}: SyntaxTagBadgeProps): React.ReactElement {
  return (
    <span className="syntax-tag">
      <span className={`syntax-tag__block syntax-tag__block--${tone}`}>{label}</span>
      {meta ? <span className="syntax-tag__meta">{`{${meta}}`}</span> : null}
    </span>
  );
}

export interface InputFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string;
  errorText?: string;
}

export function InputField({
  label,
  helperText,
  errorText,
  id,
  className = '',
  ...rest
}: InputFieldProps): React.ReactElement {
  const autoId = useId();
  const inputId = id ?? autoId;
  const msgId = `${inputId}-msg`;
  const hasError = Boolean(errorText);

  return (
    <div className="ui-field">
      <label htmlFor={inputId} className="ui-field__label">
        {label}
      </label>
      <input
        id={inputId}
        className={`ui-input ${hasError ? 'ui-input--invalid' : ''} ${className}`.trim()}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError || helperText ? msgId : undefined}
        {...rest}
      />
      {hasError ? (
        <div id={msgId} className="ui-field__error" role="alert">
          [ERR] {errorText}
        </div>
      ) : helperText ? (
        <div id={msgId} className="ui-field__helper">
          {helperText}
        </div>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: SelectOption[];
  helperText?: string;
  errorText?: string;
}

export function SelectField({
  label,
  options,
  helperText,
  errorText,
  id,
  className = '',
  ...rest
}: SelectFieldProps): React.ReactElement {
  const autoId = useId();
  const selectId = id ?? autoId;
  const msgId = `${selectId}-msg`;
  const hasError = Boolean(errorText);

  return (
    <div className="ui-field">
      <label htmlFor={selectId} className="ui-field__label">
        {label}
      </label>
      <select
        id={selectId}
        className={`ui-select ${hasError ? 'ui-select--invalid' : ''} ${className}`.trim()}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError || helperText ? msgId : undefined}
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {hasError ? (
        <div id={msgId} className="ui-field__error" role="alert">
          [ERR] {errorText}
        </div>
      ) : helperText ? (
        <div id={msgId} className="ui-field__helper">
          {helperText}
        </div>
      ) : null}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export interface TabsProps<T extends string> {
  ariaLabel: string;
  tabs: TabItem<T>[];
  activeTab: T;
  onSelect: (id: T) => void;
}

export function Tabs<T extends string>({
  ariaLabel,
  tabs,
  activeTab,
  onSelect,
}: TabsProps<T>): React.ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const nextIdx = (idx + delta + tabs.length) % tabs.length;
    onSelect(tabs[nextIdx].id);
  };

  return (
    <div className="ui-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab, idx) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className="ui-tab"
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined ? <span>[{tab.count}]</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface PixelHudMeterProps {
  label: string;
  valueText: string;
  filledSegments: number;
  totalSegments?: number;
  tone?: 'cyan' | 'magenta' | 'success' | 'warning';
}

export function PixelHudMeter({
  label,
  valueText,
  filledSegments,
  totalSegments = 10,
  tone = 'cyan',
}: PixelHudMeterProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(totalSegments, Math.round(filledSegments)));

  return (
    <div className="pixel-meter" role="group" aria-label={`${label}: ${valueText}`}>
      <div className="pixel-meter__header">
        <span>{label}</span>
        <span>{valueText}</span>
      </div>
      <div
        className="pixel-meter__track"
        style={{ gridTemplateColumns: `repeat(${totalSegments}, 1fr)` }}
        aria-hidden="true"
      >
        {Array.from({ length: totalSegments }).map((_, i) => (
          <span
            key={`seg-${i}`}
            className={
              i < clamped
                ? `pixel-meter__cell pixel-meter__cell--filled-${tone}`
                : 'pixel-meter__cell'
            }
          />
        ))}
      </div>
    </div>
  );
}

export interface StatusBannerProps {
  title: string;
  description: string;
  tone?: 'neutral' | 'error' | 'success' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
}

export function StatusBanner({
  title,
  description,
  tone = 'neutral',
  actionLabel,
  onAction,
}: StatusBannerProps): React.ReactElement {
  const toneClass =
    tone === 'error'
      ? 'status-box--error'
      : tone === 'success'
        ? 'status-box--success'
        : tone === 'warning'
          ? 'status-box--warning'
          : '';

  return (
    <div
      className={`status-box ${toneClass}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <h3 className="status-box__title">{title}</h3>
      <p className="status-box__desc">{description}</p>
      {actionLabel && onAction ? (
        <div style={{ marginTop: 'var(--space-2xs)' }}>
          <Button
            variant={tone === 'error' ? 'danger' : 'primary'}
            size="sm"
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface ModalDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function ModalDialog({
  open,
  title,
  onClose,
  children,
}: ModalDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      openerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      openerRef.current?.focus();
    }
  }, [open]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      aria-label={title}
      onClose={onClose}
      onClick={handleBackdropClick}
    >
      <header className="crt-window__titlebar">
        <div className="crt-window__title-left">
          <span className="crt-window__dots" aria-hidden="true">
            <span className="crt-dot crt-dot--magenta" />
            <span className="crt-dot crt-dot--cyan" />
            <span className="crt-dot crt-dot--violet" />
          </span>
          <h2 className="crt-window__title">{title}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Tutup dialog ${title}`}>
          [ESC]
        </Button>
      </header>
      <div className="crt-window__body">{children}</div>
    </dialog>
  );
}

export interface PixelIdenticonProps {
  seed: string;
  size?: number;
}

/**
 * Menghasilkan matriks piksel simetris 5x5 deterministik dari fingerprint Ed25519 asli.
 */
export function PixelIdenticon({ seed, size = 32 }: PixelIdenticonProps): React.ReactElement {
  const normalized = seed || 'p2pod000000000000';
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const useCyan = (hash & 1) === 0;
  const fillVar = useCyan ? 'var(--accent-secondary)' : 'var(--accent-primary)';
  const cells: Array<{ x: number; y: number }> = [];

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bitIndex = row * 3 + col;
      const on = ((hash >>> bitIndex) & 1) === 1;
      if (on) {
        cells.push({ x: col, y: row });
        if (col < 2) {
          cells.push({ x: 4 - col, y: row });
        }
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 7 7"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{
        backgroundColor: 'var(--surface-canvas)',
        border: '1px solid var(--border-default)',
        flexShrink: 0,
      }}
    >
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x + 1} y={c.y + 1} width={1} height={1} fill={fillVar} />
      ))}
    </svg>
  );
}
