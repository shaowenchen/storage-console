import type { CSSProperties, Ref } from 'react';

type Props = {
  open: boolean;
  isFolder?: boolean;
  isPublic?: boolean;
  /** When false, hide Set Public/Private (ACL unsupported or still loading for files). */
  showAclActions?: boolean;
  className?: string;
  style?: CSSProperties;
  menuRef?: Ref<HTMLDivElement>;
  onDownload?: () => void;
  onCopyLink?: () => void;
  onCopyDownloadCli?: () => void;
  onMove: () => void;
  onSetPublic: () => void;
  onSetPrivate: () => void;
  onDelete: () => void;
};

export function FileActionMenu({
  open,
  isFolder = false,
  isPublic = false,
  showAclActions = true,
  className = 'file-menu',
  style,
  menuRef,
  onDownload,
  onCopyLink,
  onCopyDownloadCli,
  onMove,
  onSetPublic,
  onSetPrivate,
  onDelete,
}: Props) {
  if (!open) return null;

  return (
    <div ref={menuRef} className={className} style={style}>
      {!isFolder && onCopyLink ? (
        <button type="button" className="bucket-action" onClick={onCopyLink}>
          Copy Link
        </button>
      ) : null}
      {!isFolder && onDownload ? (
        <button type="button" className="bucket-action" onClick={onDownload}>
          Download(direct)
        </button>
      ) : null}
      {!isFolder && onCopyDownloadCli ? (
        <button type="button" className="bucket-action" onClick={onCopyDownloadCli}>
          Download(cli)
        </button>
      ) : null}
      <button type="button" className="bucket-action" onClick={onMove}>
        Move
      </button>
      {showAclActions ? (
        isPublic ? (
          <button type="button" className="bucket-action" onClick={onSetPrivate}>
            Set Private
          </button>
        ) : (
          <button type="button" className="bucket-action" onClick={onSetPublic}>
            Set Public
          </button>
        )
      ) : null}
      <button type="button" className="bucket-action danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
