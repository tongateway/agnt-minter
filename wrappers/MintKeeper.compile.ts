import { CompilerConfig } from '@ton/blueprint';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/mint-keeper.tolk',
    withStackComments: true,    // Fift output will contain comments, if you wish to debug its output
    withSrcLineComments: true,  // Fift output will contain .tolk lines as comments
    experimentalOptions: '',    // you can pass experimental compiler options here

    postCompileHook: async (code) => {
        const auto = path.join(__dirname, '..', 'contracts', 'auto');
        await mkdir(auto, { recursive: true });
        await writeFile(path.join(auto, 'mint-keeper-code.tolk'), `
fun mintKeeperCode(): cell
    asm "B{${code.toBoc().toString('hex')}} B>boc PUSHREF";`);
    },
};
