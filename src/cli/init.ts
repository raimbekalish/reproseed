import { EXIT } from "./errors.ts";
import { assertCanReplace, resolveOutputPath, writePublishedFile } from "./outputs.ts";
import { starterNotes, starterScenario, type StarterOracle } from "./starter.ts";

export type { StarterOracle };

export const DEFAULT_INIT_PATH = "scenario.json";

export type InitCommand = {
  scenarioPath: string;
  oracle: StarterOracle;
  force: boolean;
  cwd: string;
  stdout: (text: string) => void;
};

/** Writes one starter scenario. Existing files stay in place unless force is set. */
export async function runInitCommand(input: InitCommand): Promise<number> {
  const path = await resolveOutputPath(input.cwd, input.scenarioPath, "scenario");
  await assertCanReplace(path, input.force);
  const body = starterScenario(input.oracle);
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (text.includes("resetAuthorization") || text.includes("REPROSEED_RESET_AUTHORIZATION")) {
    throw new Error("starter scenario contained a reset credential field");
  }
  await writePublishedFile(path, text, input.force);
  input.stdout(starterNotes(input.oracle, input.scenarioPath));
  return EXIT.verified;
}
