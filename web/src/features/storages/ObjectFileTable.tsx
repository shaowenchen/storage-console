import { useState } from 'react';
import type { StorageFileItem } from './types';
import { FileRowActions } from '../../shared/components/FileRowActions';
import { formatDate, formatSize } from '../../shared/format';

const DRAG_OBJECT_KEY = 'storage-console-object-key';

type Props = {
  bucketId: string;
  items: StorageFileItem[];
  /** When true and items are empty, render nothing instead of the empty-state panel. */
  pending?: boolean;
  onOpenFolder: (relativePrefix: string) => void;
  onDownload: (key: string) => void;
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
  onOpenFolder,
  onDownload,
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
        <col className="col-acl" />
        <col className="col-date" />
        <col className="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Object</th>
          <th className="table-size">Size</th>
          <th>ACL</th>
          <th>Modified</th>
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
              onDragOver={
                isFolder && onDropMove
                  ? (e) => {
                      if (!e.dataTransfer.types.includes(DRAG_OBJECT_KEY)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDropTargetKey(item.key);
                    }
                  : undefined
              }
              onDragLeave={
                isFolder && onDropMove
                  ? () => {
                      if (dropTargetKey === item.key) setDropTargetKey(null);
                    }
                  : undefined
              }
              onDrop={
                isFolder && onDropMove
                  ? (e) => {
                      e.preventDefault();
                      setDropTargetKey(null);
                      const sourceKey = e.dataTransfer.getData(DRAG_OBJECT_KEY);
                      if (!sourceKey || sourceKey === item.key) return;
                      onDropMove(sourceKey, item);
                    }
                  : undefined
              }
            >
              <td
                className={
                  isFolder ? 'object-cell clickable' : 'object-cell file-row-draggable'
                }
                draggable={!isFolder}
                onDragStart={
                  !isFolder
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
              </td>
              <td className="table-size">{isFolder ? '-' : formatSize(item.size)}</td>
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
              <td className="table-date">{isFolder ? '-' : formatDate(item.createdAt)}</td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
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
                  onDownload={!isFolder ? () => onDownload(item.key) : undefined}
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
