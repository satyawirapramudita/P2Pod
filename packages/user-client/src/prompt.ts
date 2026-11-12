// packages/user-client/src/prompt.ts
// Helper prompt interaktif untuk wizard.

import * as readline from 'readline';

export interface Prompter {
  ask(question: string): Promise<string>;
  askDefault(question: string, defaultValue: string): Promise<string>;
  askYesNo(question: string): Promise<boolean>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  return {
    ask,
    async askDefault(question: string, defaultValue: string): Promise<string> {
      const answer = (await ask(`${question} [${defaultValue}]: `)).trim();
      return answer.length > 0 ? answer : defaultValue;
    },
    async askYesNo(question: string): Promise<boolean> {
      const answer = (await ask(`${question} (y/N): `)).trim().toLowerCase();
      return answer === 'y' || answer === 'ya' || answer === 'yes';
    },
    close(): void {
      rl.close();
    },
  };
}
