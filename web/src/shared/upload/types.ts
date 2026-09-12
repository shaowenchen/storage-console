/** Response to starting a chunked upload (POST /storages/:id/upload-multipart). */
export type UploadSessionResponse = {
  uploadToken: string;
  key: string;
  name: string;
  size: number;
  contentType: string;
  relativePath: string;
  /** Maximum bytes per part; the client slices to this. */
  partSize: number;
  partCount: number;
  /**
   * How long the server may spend on one part. The client waits longer than
   * this, so a slow-but-working part is not abandoned mid-retry.
   */
  partBudgetMs?: number;
  /**
   * Whether parts may be sent straight to the bucket. When false (the bucket
   * does not permit this origin, or no origin could be established) parts go
   * through the console instead — slower, but always available.
   */
  directUpload?: boolean;
  /** Why direct upload is unavailable, for the log rather than the user. */
  directUploadReason?: string;
};

/** One part's receipt, fed back at completion. */
export type UploadedPart = {
  partNumber: number;
  etag: string;
  size: number;
};

export type CompletedUpload = {
  key: string;
  name: string;
  size: number;
  contentType: string;
  relativePath?: string;
};

export type StorageUploadContext = {
  mode: 'storage';
  bucketId: string;
  relativePath?: string;
};

export type UploadProgress = {
  percent: number;
  message: string;
};

/** Server-side upload constraints (see GET /storages/upload-limits). */
export type UploadLimits = {
  maxFiles: number;
  maxBytes: number;
};
