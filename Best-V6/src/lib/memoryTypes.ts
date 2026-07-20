export interface Memory {
  id: string;
  category: 
    | "identity" 
    | "preference" 
    | "goal" 
    | "project" 
    | "relationship" 
    | "emotional" 
    | "frequent"
    | "temporary"
    | "behavior";
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCategory = Memory["category"];

export interface LearnedRule {
  id: string;
  category: "behavior_improvement" | "error_correction" | "automation_rule" | "decision_rule";
  rule: string;
  context?: string;
  createdAt: string;
  updatedAt: string;
}

export type LearnedRuleCategory = LearnedRule["category"];

export interface MemoryTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id: string;
  category: MemoryCategory;
  text: string;
}

export interface LearningTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id: string;
  category: LearnedRuleCategory;
  rule: string;
  context?: string;
}
