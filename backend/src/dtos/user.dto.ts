import { Router, Request, Response } from "express";

import { mockUser } from "../datas/mockUser";
import { User } from "../types/user";

export function getAllUsers(req: Request, res: Response<User[]>) {
  res.status(200).json(mockUser);
}

export function getUserById(
  req: Request,
  res: Response<User | { message: string }>,
) {
  const user = req.user;
  if (!user) {
    return res.status(404).json({ message: "user not found" });
  }
  return res.status(200).json(user);
}

export function createUser(
  req: Request<{}, {}, Omit<User, "id">>,
  res: Response<User | { message: string }>,
) {
  const id = mockUser.length + 1;
  const body = req.body;
  const newUser: User = { id, ...body };
  mockUser.push(newUser);
  return res.status(201).json(newUser);
}
export function updateUser(
  req: Request<{}, {}, Partial<User>>,
  res: Response<User | { message: string }>,
) {
  const id = req.userId;
  if (id == undefined) {
    return res.json({ message: "Failed" });
  }
  const data = req.body;
  const user = req.user;
  if (!user) {
    return res.status(400).json({ message: "Not FOund" });
  }
  const updatedUser: User = { ...user, ...data };
  const userIndex = req.userIndex;
  if (userIndex === -1 || userIndex == undefined) {
    return res
      .status(404)
      .json({ message: "User index not found in database" });
  }
  mockUser[userIndex] = updatedUser;
  return res.status(200).json(updatedUser);
}

export function deleteUser(req: Request, res: Response) {
  const id = req.userId;
  if (id == undefined) {
    return res.json({ message: "Failed" });
  }
  const userIndex = req.userIndex;
  if (userIndex === -1 || userIndex == undefined) {
    return res
      .status(404)
      .json({ message: "User index not found in database" });
  }
  mockUser.splice(userIndex, 1);
  return res.status(200).json({ message: `Deletion completed of id ${id}` });
}
