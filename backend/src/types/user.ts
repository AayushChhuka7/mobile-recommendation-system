export interface User {
  id: number;
  name: string;
  email: string;
  password: string;
  phone: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: number;
      user?: User;
      userIndex?: number;
    }
  }
}
