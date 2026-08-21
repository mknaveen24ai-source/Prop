import React, { useEffect, useId } from 'react';
import { renderIcon } from '../../utils/iconMap';
import useFocusTrap from '../../hooks/useFocusTrap';

/**
 * Shared admin modal.
 *
 * Accessibility, all of which was missing: it is announced as a dialog and
 * named by its own heading, Escape closes it, Tab is contained inside it, and
 * focus returns to whatever opened it. Eleven call sites inherit that from
 * here rather than each re-implementing it.
 */
export default function AdminModal({
  isOpen,
  onClose,
  title,
  size = 'md',
  footer,
  children
}) {
  // Generated rather than derived from `title`: two modals can share a title,
  // and duplicate ids make aria-labelledby resolve to the wrong heading.
  const titleId = useId();
  const panelRef = useFocusTrap(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="admin-modal-overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={`admin-modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Dialog'}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="admin-modal-header">
          <h3 className="admin-modal-title" id={titleId}>{title}</h3>
          <button
            type="button"
            className="admin-modal-close"
            onClick={onClose}
            aria-label="Close dialog"
          >
            {renderIcon('close', { size: 16, color: 'var(--admin-text-faint)' })}
          </button>
        </div>

        <div className="admin-modal-body">
          {children}
        </div>

        {footer && (
          <div className="admin-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
