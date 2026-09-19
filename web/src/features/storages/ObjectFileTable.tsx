import { useState } from 'react';
import type { StorageFileItem } from './types';
import { FileRowActions } from '../../shared/components/FileRowActions';
import { formatDate, formatSize } from '../../shared/format';
import { looksLikeTextFileName } from './textFile';

const DRAG_OBJECT_KEY = 'storage-console-object-key';

type Props = {
  bucketId: string;
  items: StorageFileItem[];
  /** When true and items are empty, render nothing instead of the empty-state panel. */
  pending?: boolean;
  /**
   * Narrow viewport: drop the ACL and Modified columns. A phone cannot show
   * five columns of a dense table without cramping the object name, which is
   * the column people actually read. ACL stays reachable from the row menu,
   * and a file can still be opened to inspect it.
   */
  compact?: boolean;
  onOpenFolder: (relativePrefix: string) => void;
  onOpen: (key: string) => void;
  onEdit: (key: string) => void;
  onDownload: (key: string) => void;
  onDownloadFolder: (key: string) => void;
  onCopyLink: (item: StorageFileItem) => void;
  onCopyDownloadCli: (item: StorageFileItem) => void;
  onMove: (key: string, isPrefix: boolean) => void;
  onDropMove?: (sourceKey: string, targetFolder: StorageFileItem) => void;
  onSetPublic: (key: string, isPrefix: boolean) => void;
  onSetPrivate: (key: string, isPrefix: boolean) => void;
  onDelete: (key: string, isPrefix: boolean) => void;
  onItemAccessChange?: (key: string, access: { isPublic: boolean; publicUrl?: string }) => void;
};

export function ObjectFileTable({
  bucketId,
  items,
  pending = false,
  compact = false,
  onOpenFolder,
  onOpen,
  onEdit,
  onDownload,
  onDownloadFolder,
  onCopyLink,
  onCopyDownloadCli,
  onMove,
  onDropMove,
  onSetPublic,
  onSetPrivate,
  onDelete,
  onItemAccessChange,
}: Props) {
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  if (!items.length) {
    if (pending) return null;
    return (
      <div className="empty-state">
        <div>
          <strong>No objects found</strong>
          <span>No objects exist under the configured bucket path.</span>
        </div>
      </div>
    );
  }

  // Keep API/append order so Load more does not reshuffle already-visible rows.
  return (
    <table className="file-table">
      <colgroup>
        <col />
        <col className="col-size" />
        {compact ? null : (
          <>
            <col className="col-acl" />
            <col className="col-date" />
          </>
        )}
        <col className="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Object</th>
          <th className="table-size">Size</th>
          {compact ? null : (
            <>
              <th>ACL</th>
              <th>Modified</th>
            </>
          )}
          <th className="actions" />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const menuId = `${bucketId}-${item.key}`;
          const isFolder = item.type === 'folder';
          const objectName = isFolder
            ? (item.name || item.relativePath || item.path || '').trim()
            : (item.key.split('/').filter(Boolean).pop() || item.key).trim();
          const metaPath = (item.relativePath || item.path || '').replace(/\/+$/g, '');
          const showMeta = Boolean(metaPath) && metaPath !== objectName;
          const isDropTarget = isFolder && dropTargetKey === item.key;
          const menuOpen = openMenuId === menuId;
          // HTML5 drag needs a mouse: a touch drag scrolls the table, so the
          // reorder-by-drag affordance is worse than useless there.
          const draggable = !isFolder && !compact;
          // One tap opens a file on a phone; a double click is unreachable on
          // touch and a double tap would fire this twice, opening two tabs.
          const openFile = () => onOpen(item.key);
          const tapToOpen = compact && !isFolder;
          return (
            <tr
              key={item.key}
              className={[
                isFolder ? 'folder-row' : 'file-row',
                isDropTarget ? 'folder-drop-target' : '',
                menuOpen ? 'row-menu-open' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={tapToOpen ? openFile : undefined}
              onDragOver={
                isFolder && onDropMove && !compact
                  ? (e) => {
                      if (!e.dataTransfer.types.includes(DRAG_OBJECT_KEY)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropTargetKey(item.key);
                    }
                  : undefined
              }
              onDragLeave={
                isFolder && onDropMove && !compact
                  ? () => {
                      if (dropTargetKey === item.key) setDropTargetKey(null);
                    }
                  : undefined
              }
              onDrop={
                isFolder && onDropMove && !compact
                  ? (e) => {
                      e.preventDefault();
                      setDropTargetKey(null);
                      const sourceKey = e.dataTransfer.getData(DRAG_OBJECT_KEY);
                      if (!sourceKey || sourceKey === item.key) return;
                      onDropMove(sourceKey, item);
                    }
                  : undefined
              }
              onDoubleClick={tapToOpen ? undefined : isFolder ? undefined : openFile}
            >
              <td
                className={
                  isFolder
                    ? 'object-cell clickable'
                    : draggable
                      ? 'object-cell file-row-draggable'
                      : 'object-cell file-row-tappable'
                }
                draggable={draggable}
                onDragStart={
                  draggable
                    ? (e) => {
                        e.dataTransfer.setData(DRAG_OBJECT_KEY, item.key);
                        e.dataTransfer.effectAllowed = 'move';
                      }
                    : undefined
                }
                onClick={isFolder ? () => onOpenFolder(item.relativePath || '') : undefined}
              >
                <span className="object-name" title={item.key}>
                  {objectName}
                </span>
                {showMeta ? (
                  <div className="object-meta" title={metaPath}>
                    {metaPath}
                  </div>
                ) : null}
                {compact && !isFolder ? (
                  <span className="object-open-cue" aria-hidden="true">
                    ›
                  </span>
                ) : null}
              </td>
              <td className="table-size">{isFolder ? '-' : formatSize(item.size)}</td>
              {compact ? null : (
                <td className="table-acl">
                  {isFolder ? (
                    '-'
                  ) : !item.aclResolved ? (
                    <span className="acl-pending">…</span>
                  ) : item.aclSupported === false ? (
                    <span className="acl-na">—</span>
                  ) : item.isPublic ? (
                    <span className="acl-public">Public</span>
                  ) : (
                    <span className="acl-private">Private</span>
                  )}
                </td>
              )}
              {compact ? null : (
                <td className="table-date">{isFolder ? '-' : formatDate(item.createdAt)}</td>
              )}
              <td
                className="actions"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <FileRowActions
                  menuId={menuId}
                  openMenuId={openMenuId}
                  onOpenMenuChange={setOpenMenuId}
                  objectKey={item.key}
                  bucketId={bucketId}
                  onAccessResolved={
                    onItemAccessChange
                      ? (access) => onItemAccessChange(item.key, access)
                      : undefined
                  }
                  isFolder={isFolder}
                  isPublic={item.isPublic}
                  publicUrl={item.publicUrl}
                  aclSupported={item.aclSupported}
                  aclResolved={item.aclResolved}
                  onOpen={!isFolder ? () => onOpen(item.key) : undefined}
                  onEdit={
                    !isFolder && looksLikeTextFileName(item.name || item.key)
                      ? () => onEdit(item.key)
                      : undefined
                  }
                  onDownload={!isFolder ? () => onDownload(item.key) : undefined}
                  onDownloadFolder={isFolder ? () => onDownloadFolder(item.key) : undefined}
                  onCopyLink={!isFolder ? () => onCopyLink(item) : undefined}
                  onCopyDownloadCli={!isFolder ? () => onCopyDownloadCli(item) : undefined}
                  onMove={() => onMove(item.key, isFolder)}
                  onSetPublic={() => onSetPublic(item.key, isFolder)}
                  onSetPrivate={() => onSetPrivate(item.key, isFolder)}
                  onDelete={() => onDelete(item.key, isFolder)}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
