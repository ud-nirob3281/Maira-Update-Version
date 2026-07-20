import fs from "fs/promises";
import { GoogleGenAI, Type } from "@google/genai";
import { Memory, LearnedRule, MemoryTransaction, LearningTransaction } from "./src/lib/memoryTypes";
import { dataFile } from "./server_paths";

const MEMORY_FILE = dataFile("memories.json");
const LEARN_FILE = dataFile("learn.json");

/**
 * MemoryCacheManager provides a lightning-fast, production-grade,
 * non-blocking in-memory cache layer for both memories and learned rules.
 * Serving O(1) reads while throttling background I/O to guarantee
 * maximum performance, zero UI lags, and zero duplicate writes.
 */
class MemoryCacheManager {
  private memories: Memory[] = [];
  private learnedRules: LearnedRule[] = [];
  private isLoaded = false;
  private writeTimer: NodeJS.Timeout | null = null;
  private loadingPromise: Promise<void> | null = null;

  public async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        // Load memories.json
        try {
          const memData = await fs.readFile(MEMORY_FILE, "utf-8");
          this.memories = JSON.parse(memData) as Memory[];
          // Clean duplicates/corrupted entries on load
          this.memories = this.deduplicateMemories(this.memories);
        } catch (error: any) {
          if (error.code !== "ENOENT") {
            console.error("[MemoryCache] Error reading memories file:", error);
          }
          this.memories = [];
        }

        // Load learn.json
        try {
          const learnData = await fs.readFile(LEARN_FILE, "utf-8");
          this.learnedRules = JSON.parse(learnData) as LearnedRule[];
          this.learnedRules = this.deduplicateRules(this.learnedRules);
        } catch (error: any) {
          if (error.code !== "ENOENT") {
            console.error("[MemoryCache] Error reading learn file:", error);
          }
          this.learnedRules = [];
        }

        this.isLoaded = true;
        console.log(`[MemoryCache] Core loaded: ${this.memories.length} memories, ${this.learnedRules.length} learned rules.`);
      } catch (err) {
        console.error("[MemoryCache] Failed to initialize cache:", err);
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  public async getMemories(): Promise<Memory[]> {
    await this.ensureLoaded();
    return this.memories;
  }

  public async getLearnedRules(): Promise<LearnedRule[]> {
    await this.ensureLoaded();
    return this.learnedRules;
  }

  public async setMemories(newMemories: Memory[]): Promise<void> {
    await this.ensureLoaded();
    this.memories = this.deduplicateMemories(newMemories);
    this.scheduleWrite();
  }

  public async setLearnedRules(newRules: LearnedRule[]): Promise<void> {
    await this.ensureLoaded();
    this.learnedRules = this.deduplicateRules(newRules);
    this.scheduleWrite();
  }

  /**
   * Throttled, non-blocking asynchronous disk writer to prevent disk thrashing and server lags.
   */
  private scheduleWrite() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(async () => {
      try {
        await fs.writeFile(MEMORY_FILE, JSON.stringify(this.memories, null, 2), "utf-8");
        await fs.writeFile(LEARN_FILE, JSON.stringify(this.learnedRules, null, 2), "utf-8");
        console.log(`[MemoryCache] Sync completed asynchronously. Cached data safely written to disk.`);
      } catch (err) {
        console.error("[MemoryCache] Failed to write cache to files:", err);
      }
    }, 1000); // 1-second quiet window throttle
  }

  private deduplicateMemories(mems: Memory[]): Memory[] {
    const seen = new Set<string>();
    return mems.filter((m) => {
      if (!m || !m.text || !m.category) return false;
      const key = `${m.category}:${m.text.toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private deduplicateRules(rules: LearnedRule[]): LearnedRule[] {
    const seen = new Set<string>();
    return rules.filter((r) => {
      if (!r || !r.rule || !r.category) return false;
      const key = `${r.category}:${r.rule.toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export const memoryCache = new MemoryCacheManager();

// Keep backward compatible direct loaders/savers
export async function loadMemories(): Promise<Memory[]> {
  return memoryCache.getMemories();
}

export async function saveMemories(memories: Memory[]): Promise<void> {
  await memoryCache.setMemories(memories);
}

export async function loadLearnedRules(): Promise<LearnedRule[]> {
  return memoryCache.getLearnedRules();
}

export async function saveLearnedRules(rules: LearnedRule[]): Promise<void> {
  await memoryCache.setLearnedRules(rules);
}

/**
 * Intelligent Semantic Context Dispatcher.
 * Retrieves only the most relevant memories & learned rules based on user input & task context.
 */
export async function getRelevantContextForPrompt(
  userInput: string,
  activeTaskName?: string
): Promise<{ memories: Memory[]; rules: LearnedRule[] }> {
  const allMems = await loadMemories();
  const allRules = await loadLearnedRules();

  const textLower = userInput.toLowerCase().trim();

  // 1. Language preference detection
  const isBanglaInput = /[\u0980-\u09FF]/.test(textLower) || ["bengali", "bangla", "বাংলা", "ভাষা"].some(w => textLower.includes(w));
  
  // 2. Classify context relevance filters
  const hasBrowserIntent = activeTaskName?.toLowerCase().includes("browser") || 
                           ["browser", "click", "search", "scroll", "snapshot", "type", "automation", "whatsapp", "gmail", "youtube", "amazon", "daraz"].some(w => textLower.includes(w));
  
  const hasCodingIntent = ["code", "python", "script", "createfile", "writecode", "runpython"].some(w => textLower.includes(w));

  // Filter memories
  const filteredMemories = allMems.filter(m => {
    // Identity and Preferences are almost always highly relevant
    if (m.category === "identity" || m.category === "preference") return true;
    
    // Task-specific filtering
    if (hasBrowserIntent && m.category === "frequent") return true;
    if (hasCodingIntent && m.category === "project") return true;

    // Default: include general goals, projects, and relationships to keep convo warm and human
    return ["goal", "project", "relationship"].includes(m.category);
  });

  // Filter rules
  const filteredRules = allRules.filter(r => {
    // Critical tone & behavior corrections are always highly relevant
    if (r.category === "behavior_improvement") {
      // Prioritize Bangla instructions if Bengali language context is active
      if (isBanglaInput && r.rule.toLowerCase().includes("bangla")) return true;
      if (isBanglaInput && r.rule.toLowerCase().includes("বাংলা")) return true;
      return true;
    }

    // Automation rules matched to browser context
    if (hasBrowserIntent && (r.category === "error_correction" || r.category === "automation_rule")) {
      return true;
    }

    // General decision rules
    if (r.category === "decision_rule") return true;

    // Fallback search match inside the rule string
    const ruleLower = r.rule.toLowerCase();
    if (activeTaskName && ruleLower.includes(activeTaskName.toLowerCase())) return true;
    
    return false;
  });

  return {
    memories: filteredMemories,
    rules: filteredRules
  };
}

// Keep legacy formatter signature but map to standard category layout
export function formatSystemInstructionsWithMemories(baseInstruction: string, memories: Memory[]): string {
  return formatSystemInstructionsWithContext(baseInstruction, memories, [], []);
}

/**
 * Builds Myraa's persistent memory and cognitive learning prompt block.
 * Uses a strict multi-priority sorting layout to ensure conflict resolution and optimal execution.
 */
export function formatSystemInstructionsWithContext(
  baseInstruction: string,
  memories: Memory[],
  rules: LearnedRule[],
  recentConversation: { role: string; text: string }[]
): string {
  let block = "\n\n=== MYRAA PERSISTENT COGNITIVE CORE ===\n";

  // Priority 1: High Priority Behavioral Improvements & Learning Rules
  if (rules.length > 0) {
    block += "\n[COGNITIVE LEARNING CORE - ACTIVE RULES & BEHAVIOR (PRIORITY 1)]\n";
    block += "You must strictly adapt your behavior according to these feedback rules learned from past conversations:\n";
    
    const groups: Record<string, string[]> = {};
    rules.forEach(r => {
      groups[r.category] = groups[r.category] || [];
      groups[r.category].push(r.rule);
    });

    const ruleOrder = [
      { key: "behavior_improvement", label: "Communication Style & Persona Guidelines" },
      { key: "error_correction", label: "Automation Correction Rules (Mistakes Learned)" },
      { key: "automation_rule", label: "Custom Automation Guides" },
      { key: "decision_rule", label: "General Decision Frameworks" }
    ];

    ruleOrder.forEach(cat => {
      const list = groups[cat.key] || [];
      if (list.length > 0) {
        block += `* ${cat.label}:\n` + list.map(item => `  - ${item}`).join("\n") + "\n";
      }
    });
  } else {
    block += "\n[COGNITIVE LEARNING CORE]\nNo rules have been hard-taught yet. Remain sweet, helpful, and learn actively from any user/developer feedback.\n";
  }

  // Priority 2: Persistent Recollections Card (User Profile)
  if (memories.length > 0) {
    block += "\n[PERSISTENT KNOWLEDGE CARD (PRIORITY 2)]\n";
    block += "Your persistent recollections of your friend TECH:\n";

    const groups: Record<string, string[]> = {};
    memories.forEach(m => {
      groups[m.category] = groups[m.category] || [];
      groups[m.category].push(m.text);
    });

    const memOrder = [
      { key: "identity", label: "Identity & Personal Details" },
      { key: "preference", label: "Preferences & Tastes" },
      { key: "goal", label: "Aspirations & Goals" },
      { key: "project", label: "Ongoing Projects" },
      { key: "relationship", label: "Key People & Relationships" },
      { key: "emotional", label: "Emotional Highlights & Milestones" },
      { key: "frequent", label: "Frequently Used Data" },
      { key: "temporary", label: "Current Active Session Context" }
    ];

    memOrder.forEach(cat => {
      const list = groups[cat.key] || [];
      if (list.length > 0) {
        block += `* ${cat.label}:\n` + list.map(item => `  - ${item}`).join("\n") + "\n";
      }
    });
  }

  // Priority 3: Seamless Conversation Continuity Context
  if (recentConversation && recentConversation.length > 0) {
    block += "\n[RECENT CONVERSATION CONTEXT (RESUMED) (PRIORITY 3)]\n";
    block += "You recently had a quick cognitive synchronization. Below is the transcript of your active conversation before this sync. Seamlessly resume speaking to the user based on this history with no disconnect or amnesia:\n";
    recentConversation.forEach(line => {
      block += `${line.role === "user" ? "User" : "Myraa"}: ${line.text}\n`;
    });
  }

  block += "\n=========================================\n";

  return baseInstruction + block;
}

// Background memory/learning extraction lock
let isConsolidating = false;

/**
 * High-performance Cognitive Consolidation Pipeline.
 * Extracts memories (memories.json) and Learned Behaviors (learn.json) in one single,
 * cohesive LLM operation, automatically updating the caches and writing back with zero lag.
 */
export async function processConversationSlice(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[]
): Promise<Memory[] | null> {
  if (isConsolidating) {
    console.log("[MemoryCache] Pipeline is busy. Skipping turn consolidation.");
    return null;
  }

  if (dialogueHistory.length < 2) {
    return null;
  }

  isConsolidating = true;
  console.log("[MemoryCache] Starting background cognitive consolidation pipeline...");

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });

    const currentMemories = await loadMemories();
    const currentRules = await loadLearnedRules();

    const memoriesStr = currentMemories.map(m => `[ID: ${m.id}] Category: ${m.category} | Fact: ${m.text}`).join("\n");
    const rulesStr = currentRules.map(r => `[ID: ${r.id}] Category: ${r.category} | Rule: ${r.rule}`).join("\n");
    const dialogueStr = dialogueHistory.map(line => `${line.role === "user" ? "User" : "Myraa"}: ${line.text}`).join("\n");

    const prompt = `You are Myraa's dual-core cognitive recollection and behavioral learning engine. 
Analyze the recent conversation piece to extract new facts, enduring preferences, goals, or critical behavior improvements.

### OBJECTIVE
1. **User Memories (memories.json)**: Extract durable user-specific facts, ongoing projects, relationships, goals, or long-term preferences. Avoid cataloging general greeting text.
2. **Behavioral Rules (learn.json)**: Pay extreme attention to when the user or developer corrects your behavior, speaks about communication styles, points out errors (e.g. "always speak in Bengali", "don't guess selectors", "On Facebook, click the profile first"), or gives explicit automation, conversational, or decision instructions. These are cognitive behavior rules.
3. **Avoid Duplicates**: If a rule or memory already exists, do NOT output a duplicate ADD. If previous info is corrected, output an UPDATE transaction with the correct ID.

### CURRENT COGNITIVE DATA CARD:
[Memories Card]
${memoriesStr || "(None)"}

[Behavioral Learning Card]
${rulesStr || "(None)"}

### RECENT DIALOGUE HISTORY:
${dialogueStr}

### RULES
- Actions: "ADD" (new facts/rules), "UPDATE" (evolved or changed facts/rules), "REMOVE" (if user asks to forget).
- Text Style: Concise, third-person declarative summaries (e.g., "The user is studying computer science", "Rule: Always check WhatsApp input box before typing"). No filler words.
- ID: Specify the exact existing ID for UPDATE or REMOVE, leave blank or null for ADD.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transactions: {
              type: Type.ARRAY,
              description: "Transactions for memories.json (user-specific facts).",
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, enum: ["ADD", "UPDATE", "REMOVE"] },
                  id: { type: Type.STRING },
                  category: { type: Type.STRING, enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "frequent", "temporary"] },
                  text: { type: Type.STRING, description: "Declarative fact or preference statement in third-person." }
                },
                required: ["action", "category", "text"]
              }
            },
            learningTransactions: {
              type: Type.ARRAY,
              description: "Transactions for learn.json (cognitive behavior, error correction, and automation rules).",
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING, enum: ["ADD", "UPDATE", "REMOVE"] },
                  id: { type: Type.STRING },
                  category: { type: Type.STRING, enum: ["behavior_improvement", "error_correction", "automation_rule", "decision_rule"] },
                  rule: { type: Type.STRING, description: "Declarative learned behavior or instruction in third-person." },
                  context: { type: Type.STRING, description: "Optional specific app or language name." }
                },
                required: ["action", "category", "rule"]
              }
            }
          },
          required: ["transactions", "learningTransactions"]
        }
      }
    });

    const resultObj = JSON.parse(response.text?.trim() || '{"transactions":[],"learningTransactions":[]}');
    const transactions: MemoryTransaction[] = resultObj.transactions || [];
    const learningTransactions: LearningTransaction[] = resultObj.learningTransactions || [];

    if (transactions.length === 0 && learningTransactions.length === 0) {
      console.log("[MemoryCache] Zero cognitive changes extracted from dialogue slice.");
      isConsolidating = false;
      return null;
    }

    const timestamp = new Date().toISOString();

    // 1. Process Memories Card
    let updatedMemories = [...currentMemories];
    for (const trx of transactions) {
      if (trx.action === "ADD") {
        updatedMemories.push({
          id: Math.random().toString(36).substring(2, 11),
          category: trx.category,
          text: trx.text,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } else if (trx.action === "UPDATE") {
        const idx = updatedMemories.findIndex(m => m.id === trx.id);
        if (idx !== -1) {
          updatedMemories[idx] = {
            ...updatedMemories[idx],
            category: trx.category,
            text: trx.text,
            updatedAt: timestamp
          };
        } else {
          updatedMemories.push({
            id: Math.random().toString(36).substring(2, 11),
            category: trx.category,
            text: trx.text,
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
      } else if (trx.action === "REMOVE") {
        updatedMemories = updatedMemories.filter(m => m.id !== trx.id);
      }
    }

    // 2. Process Behavioral Learning Card
    let updatedRules = [...currentRules];
    for (const trx of learningTransactions) {
      if (trx.action === "ADD") {
        updatedRules.push({
          id: Math.random().toString(36).substring(2, 11),
          category: trx.category,
          rule: trx.rule,
          context: trx.context,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } else if (trx.action === "UPDATE") {
        const idx = updatedRules.findIndex(r => r.id === trx.id);
        if (idx !== -1) {
          updatedRules[idx] = {
            ...updatedRules[idx],
            category: trx.category,
            rule: trx.rule,
            context: trx.context,
            updatedAt: timestamp
          };
        } else {
          updatedRules.push({
            id: Math.random().toString(36).substring(2, 11),
            category: trx.category,
            rule: trx.rule,
            context: trx.context,
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
      } else if (trx.action === "REMOVE") {
        updatedRules = updatedRules.filter(r => r.id !== trx.id);
      }
    }

    // Safely update Cache Managers which triggers asynchronous file-syncs
    await memoryCache.setMemories(updatedMemories);
    await memoryCache.setLearnedRules(updatedRules);

    console.log(`[MemoryCache] Pipeline sync complete: Added/Updated ${transactions.length} memories & ${learningTransactions.length} rules.`);
    isConsolidating = false;
    return updatedMemories;

  } catch (error) {
    console.error("[MemoryCache] Critical failure in background consolidation loop:", error);
    isConsolidating = false;
    return null;
  }
}
