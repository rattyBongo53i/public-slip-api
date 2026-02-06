import { Collection, ObjectId } from "mongodb";

export interface MasterSlip {
  _id?: ObjectId;
  master_slip_id: string;
  id?: number;
  user_id: string;
  stake: number;
  currency?: string;
  total_odds: number;
  estimated_payout?: number;
  status: "pending" | "active" | "resolved" | "cancelled";
  engine_status?: string;
  analysis_quality?: string;
  name?: string;
  notes?: string;
  alternative_slips_count?: number;
  best_alternative_slip_id?: number;
  bankroll?: number;
  phase_two_status?: string;
  slip_data?: any;
  processing_started_at?: Date;
  processing_completed_at?: Date;
  created_at: Date;
  updated_at: Date;
  metadata?: Record<string, any>;
  generated_slips_count?: number;
}

export interface Match {
  _id?: ObjectId;
  id: number;
  home_team: string;
  away_team: string;
}

export interface MasterSlipMatch {
  _id?: ObjectId;
  id: number;
  master_slip_id: number;
  match_id: number;
  market: string;
  selection: string;
  odds: number;
  match_data?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface GeneratedSlipLeg {
  match_id: number;
  match?: Match;
  selection: string;
  odds: number;
  market: string;
}

export interface GeneratedSlip {
  _id?: ObjectId;
  slip_id: string;
  id?: number;
  master_slip_id: string;
  legs?: GeneratedSlipLeg[];
  total_odds?: number;
  stake?: number;
  confidence_score?: number;
  risk_level?: string;
  risk_category?: string;
  generated_at?: Date;
  created_at?: Date;
  updated_at?: Date;
  status?: "active" | "won" | "lost" | "void";
  estimated_return?: number;
  estimated_payout?: number;
  possible_return?: number;
  diversity_score?: number;
  slip_data?: any;
}

export interface OptimizedSlip {
  _id?: ObjectId;
  id: number;
  master_slip_id: number;
  stake?: number;
  total_odds?: number;
  confidence_score?: number;
  estimated_payout?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface DatabaseCollections {
  master_slips: Collection<MasterSlip>;
  generated_slips: Collection<GeneratedSlip>;
  optimized_slips?: Collection<OptimizedSlip>;
  master_slip_matches?: Collection<MasterSlipMatch>;
  matches?: Collection<Match>;
}

export interface NetlifyEvent {
  httpMethod: string;
  path: string;
  queryStringParameters: Record<string, string> | null;
  body: string | null;
  headers: Record<string, string>;
}

export interface NetlifyContext {
  clientContext?: any;
}
