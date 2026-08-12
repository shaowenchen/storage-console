type Props = {
  open: boolean;
  isFolder?: boolean;
  isPublic?: boolean;
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
    <div className="file-menu">
      {!isFolder && onDownload ? (
        <button type="button" className="bucket-action" onClick={onDownload}>
          Download(direct)
        </button>
      ) : null}
      {!isFolder && onCopyLink ? (
        <button type="button" className="bucket-action" onClick={onCopyLink}>
          Copy Link
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
      {isPublic ? (
        <button type="button" className="bucket-action" onClick={onSetPrivate}>
          Set Private
        </button>
      ) : (
        <button type="button" className="bucket-action" onClick={onSetPublic}>
          Set Public
        </button>
      )}
      <button type="button" className="bucket-action danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
