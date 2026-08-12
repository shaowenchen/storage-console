import { useEffect, useRef, useState } from 'react';
import { getObjectAccess } from '../../features/storages/api';
import { FileActionMenu } from './FileActionMenu';
import { useClickOutside } from '../hooks/useClickOutside';

type ObjectAccess = { isPublic: boolean; publicUrl?: string; aclSupported?: boolean };

type Props = {
  menuId: string;
  openMenuId: string | null;
  onOpenMenuChange: (menuId: string | null) => void;
  objectKey?: string;
  bucketId?: string;
  onAccessResolved?: (access: ObjectAccess) => void;
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

export function FileRowActions({
  menuId,
  openMenuId,
  onOpenMenuChange,
  objectKey,
  bucketId,
  onAccessResolved,
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
  const rootRef = useRef<HTMLDivElement>(null);
  const onAccessResolvedRef = useRef(onAccessResolved);
  onAccessResolvedRef.current = onAccessResolved;
  const open = openMenuId === menuId;
  const [resolvedAccess, setResolvedAccess] = useState<ObjectAccess | null>(null);

  useClickOutside(rootRef, open, () => onOpenMenuChange(null));

  useEffect(() => {
    if (!open) {
      setResolvedAccess(null);
      return;
    }
    if (isFolder || !bucketId || !objectKey) return;

    let cancelled = false;
    void getObjectAccess(bucketId, objectKey)
      .then((access) => {
        if (cancelled) return;
        setResolvedAccess(access);
        onAccessResolvedRef.current?.(access);
      })
      .catch(() => {
        /* keep menu usable when ACL lookup fails */
      });

    return () => {
      cancelled = true;
    };
  }, [open, isFolder, bucketId, objectKey]);

  const displayPublic = resolvedAccess?.isPublic ?? isPublic;
  // Files: wait for GetObjectAcl probe; hide ACL actions if the bucket/provider doesn't support them.
  const showAclActions = isFolder
    ? true
    : Boolean(resolvedAccess) && resolvedAccess?.aclSupported !== false;

  function closeMenu() {
    onOpenMenuChange(null);
  }

  function withClose(action?: () => void) {
    return () => {
      closeMenu();
      action?.();
    };
  }

  return (
    <div className="file-row-actions" ref={rootRef}>
      <button
        type="button"
        className="file-menu-btn"
        aria-label="File actions"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenuChange(open ? null : menuId);
        }}
      >
        ⋮
      </button>
      <FileActionMenu
        open={open}
        isFolder={isFolder}
        isPublic={displayPublic}
        showAclActions={showAclActions}
        onDownload={onDownload ? withClose(onDownload) : undefined}
        onCopyLink={onCopyLink ? withClose(onCopyLink) : undefined}
        onCopyDownloadCli={onCopyDownloadCli ? withClose(onCopyDownloadCli) : undefined}
        onMove={withClose(onMove)}
        onSetPublic={withClose(onSetPublic)}
        onSetPrivate={withClose(onSetPrivate)}
        onDelete={withClose(onDelete)}
      />
    </div>
  );
}
