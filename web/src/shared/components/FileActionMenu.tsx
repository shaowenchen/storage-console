type Props = {
  open: boolean;
  isFolder?: boolean;
  isPublic?: boolean;
  onDownload?: () => void;
  onCopyLink?: () => void;
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
          Download
        </button>
      ) : null}
      {!isFolder && onCopyLink ? (
        <button type="button" className="bucket-action" onClick={onCopyLink}>
          Copy Link
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
