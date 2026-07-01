declare namespace Express {
  export interface Request {
    auth?: {
      userId: string;
      email?: string;
      isAdmin: boolean;
    };
    deviceFingerprint?: string;
  }
}
