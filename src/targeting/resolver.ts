import { ExitCode, RobloxAxiError } from "../errors.js";
import type { Target } from "../types.js";
import type { StudioService } from "../studio/service.js";

function quoteLuau(value: string): string {
  return JSON.stringify(value);
}

export async function resolveTarget(
  service: StudioService,
  studioId: string,
  target: Target,
): Promise<{ instancePath?: string; coordinates?: { x: number; y: number } }> {
  if ("instance_path" in target) return { instancePath: target.instance_path };
  if ("coordinates" in target) return { coordinates: target.coordinates };

  let code: string;
  if ("test_id" in target) {
    code = `for _, item in game:GetDescendants() do if item:GetAttribute("TestId") == ${quoteLuau(target.test_id)} then return item:GetFullName() end end return nil`;
  } else if ("tag" in target) {
    code = `local items = game:GetService("CollectionService"):GetTagged(${quoteLuau(target.tag)}); return items[1] and items[1]:GetFullName() or nil`;
  } else {
    const semantic = quoteLuau(target.semantic.toLocaleLowerCase());
    code = `local root=game:GetService("Players").LocalPlayer.PlayerGui; for _,item in root:GetDescendants() do local name=string.lower(item.Name); local text=""; if item:IsA("TextLabel") or item:IsA("TextButton") or item:IsA("TextBox") then text=string.lower(item.Text) end; if name==${semantic} or text==${semantic} then return item:GetFullName() end end return nil`;
  }
  const result = await service.executeLuau(studioId, "client", code);
  const path = typeof result === "string" ? result : undefined;
  if (!path) {
    throw new RobloxAxiError({
      message: "Semantic target could not be resolved to a Roblox instance",
      code: "ASSERTION_FAILED",
      exitCode: ExitCode.TestFailure,
      details: target,
    });
  }
  return { instancePath: path.startsWith("game.") ? path : `game.${path}` };
}
