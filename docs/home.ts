import * as Schema from "effect/Schema";
import { LoopCommandInput } from "@fungi.computer/shiitake-extensions/loop";

console.log(Schema.decodeUnknownSync(LoopCommandInput)({ action: "pause" }));
