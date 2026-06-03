import { NextFunction, Request, Response } from "express";

import { mockUser } from "../datas/mockUser";
import { User } from "../types/user";

export function attachUser(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
) {
  const id = req.params.id;
  const parsedId: number | undefined = parseInt(id);

  if (Number.isNaN(parsedId)) {
    return res.status(400).json({ error: "Invalid user ID format" });
  }
  const user: User | undefined = mockUser.find((user) => user.id == parsedId);

  if (!user) {
    return res.status(404).json({ message: "User Not Found" });
  }

  const index = mockUser.findIndex((user) => user.id == parsedId);
  if (index == -1) {
    return res.status(404).json({ message: "User Not Found" });
  }
  req.userId = parsedId;
  req.user = user;
  req.userIndex = index;
  next();
}
