import { REST, Routes } from "discord.js";
import { loadConfig } from "./config.js";
import { commandDefinitions } from "./commands.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);

await rest.put(
  Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
  { body: commandDefinitions }
);

console.log(`Registered ${commandDefinitions.length} Akron Discord commands.`);
