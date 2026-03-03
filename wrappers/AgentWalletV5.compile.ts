import { CompilerConfig } from '@ton/blueprint';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';


export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['contracts/agent_wallet_v5/agent_wallet_v5.fc'],

    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'agent-wallet-v5-code.tolk'), `
fun agentWalletV5Code(): cell
    asm "B{${code.toBoc().toString('hex')}} B>boc PUSHREF";`);
    },
};
