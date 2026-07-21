// Portable policy types. These types contain no deployment or provider secret.

export type ArgGuard =
  | { field: string; forbiddenValues: string[] }
  | { field: string; forbid: true }
  | { field: string; pin: string };

export interface AngelTool {
  tool: string;
  argGuards?: ArgGuard[];
}
