// Reference Plutus evaluation helpers built on the uplc crate (aiken's evaluator).
//   ctxdump ctx <dir> <zero_time_ms> <zero_slot> <slot_len_ms>            dump aiken's script context per redeemer
//   ctxdump eval-tx <dir> <zero_time_ms> <zero_slot> <slot_len_ms> <costs.json>   evaluate every redeemer (own context)
//   ctxdump eval-prog <program.hex (cbor-wrapped flat)> <v1|v2|v3> <costs.json>    evaluate an applied program
//   ctxdump eval-text <file.uplc> <v1|v2|v3> <costs.json>                          evaluate textual UPLC
// costs.json: {"PlutusV1":[..],"PlutusV2":[..],"PlutusV3":[..]} (Koios epoch_params cost_models)
use pallas_codec::minicbor;
use pallas_primitives::conway::{CostModels, Language, MintedTx, Redeemer, Redeemers, TransactionInput, TransactionOutput};
use std::fs;
use uplc::ast::{NamedDeBruijn, Program};
use uplc::machine::cost_model::ExBudget;
use uplc::tx::eval::eval_redeemer;
use uplc::tx::script_context::{find_script, PlutusScript, TxInfoV1, TxInfoV2, TxInfoV3};
use uplc::tx::to_plutus_data::ToPlutusData;
use uplc::tx::{iter_redeemers, DataLookupTable, ResolvedInput, SlotConfig};

fn read_hex(path: &str) -> Vec<u8> { hex::decode(fs::read_to_string(path).unwrap().trim()).unwrap() }
fn costs(path: &str) -> CostModels {
    let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let arr = |k: &str| v.get(k).map(|a| a.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect::<Vec<i64>>());
    CostModels { plutus_v1: arr("PlutusV1"), plutus_v2: arr("PlutusV2"), plutus_v3: arr("PlutusV3") }
}
fn lang(s: &str) -> Language { match s { "v1" => Language::PlutusV1, "v2" => Language::PlutusV2, _ => Language::PlutusV3 } }
fn lang_costs(cm: &CostModels, l: &Language) -> Vec<i64> {
    match l { Language::PlutusV1 => cm.plutus_v1.clone(), Language::PlutusV2 => cm.plutus_v2.clone(), Language::PlutusV3 => cm.plutus_v3.clone() }.expect("cost model")
}
fn report(res: uplc::machine::eval_result::EvalResult) {
    let c = res.cost();
    match res.result() {
        Ok(t) => { println!("ok cpu {} mem {} result {}", c.cpu, c.mem, t.to_pretty().replace('\n', " ")); for l in res.logs() { println!("log {}", l); } },
        Err(e) => { println!("error cpu {} mem {} : {e}", c.cpu, c.mem); for l in res.logs() { println!("log {}", l); } },
    }
}
struct TxBundle { tx_bytes: Vec<u8>, utxos: Vec<ResolvedInput>, slot: SlotConfig }
fn load_tx(args: &[String]) -> TxBundle {
    let dir = &args[2];
    let tx_bytes = read_hex(&format!("{dir}/tx.hex"));
    let ins: Vec<TransactionInput> = minicbor::decode(&read_hex(&format!("{dir}/inputs.hex"))).expect("inputs");
    let outs: Vec<TransactionOutput> = minicbor::decode(&read_hex(&format!("{dir}/outputs.hex"))).expect("outputs");
    let utxos = ins.into_iter().zip(outs).map(|(input, output)| ResolvedInput { input, output }).collect();
    let slot = SlotConfig { zero_time: args[3].parse().unwrap(), zero_slot: args[4].parse().unwrap(), slot_length: args[5].parse().unwrap() };
    TxBundle { tx_bytes, utxos, slot }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args[1].as_str() {
        "ctx" | "eval-tx" => {
            let b = load_tx(&args);
            let tx: MintedTx = minicbor::decode(&b.tx_bytes).expect("tx");
            let lookup = DataLookupTable::from_transaction(&tx, &b.utxos);
            let redeemers: &Redeemers = tx.transaction_witness_set.redeemer.as_ref().expect("redeemers");
            let cm = if args[1] == "eval-tx" { Some(costs(&args[6])) } else { None };
            for (key, data, ex_units) in iter_redeemers(redeemers) {
                let redeemer = Redeemer { tag: key.tag, index: key.index, data: data.clone(), ex_units };
                let tag = redeemer.tag as u8;
                if let Some(cm) = &cm {
                    print!("tag {} idx {} declared cpu {} mem {} -> ", tag, redeemer.index, ex_units.steps, ex_units.mem);
                    match eval_redeemer(&tx, &b.utxos, &b.slot, &redeemer, &lookup, Some(cm), &ExBudget::default()) {
                        Ok((r, _)) => println!("aiken cpu {} mem {}", r.ex_units.steps, r.ex_units.mem),
                        Err(e) => println!("error: {e}"),
                    }
                    continue;
                }
                let (script, datum) = find_script(&redeemer, &tx, &b.utxos, &lookup).expect("find_script");
                let (l, tx_info) = match script {
                    PlutusScript::V1(_) => ("v1", TxInfoV1::from_transaction(&tx, &b.utxos, &b.slot)),
                    PlutusScript::V2(_) => ("v2", TxInfoV2::from_transaction(&tx, &b.utxos, &b.slot)),
                    PlutusScript::V3(_) => ("v3", TxInfoV3::from_transaction(&tx, &b.utxos, &b.slot)),
                };
                let ctx = tx_info.expect("tx_info").into_script_context(&redeemer, datum.as_ref()).expect("ctx");
                let bytes = minicbor::to_vec(ctx.to_plutus_data()).expect("encode");
                let out = format!("{}/aiken-{}-{}.ctx.hex", args[2], tag, redeemer.index);
                fs::write(&out, hex::encode(&bytes)).unwrap();
                println!("{l} tag {} idx {} ctx {} bytes -> {out}", tag, redeemer.index, bytes.len());
            }
        }
        "eval-prog" => {
            let bytes = read_hex(&args[2]);
            let mut buf = Vec::new();
            let prog: Program<NamedDeBruijn> = Program::<uplc::ast::FakeNamedDeBruijn>::from_cbor(&bytes, &mut buf).expect("program").into();
            let l = lang(&args[3]);
            let cm = costs(&args[4]);
            report(prog.eval_as(&l, &lang_costs(&cm, &l), Some(&ExBudget::default())));
        }
        "show-prog" => {
            let bytes = read_hex(&args[2]);
            let mut buf = Vec::new();
            let prog: Program<NamedDeBruijn> = Program::<uplc::ast::FakeNamedDeBruijn>::from_cbor(&bytes, &mut buf).expect("program").into();
            println!("{}", prog.to_pretty());
        }
        "eval-text" => {
            let src = fs::read_to_string(&args[2]).unwrap();
            let prog = uplc::parser::program(&src).expect("parse");
            let prog: Program<NamedDeBruijn> = prog.try_into().expect("debruijn");
            let l = lang(&args[3]);
            let cm = costs(&args[4]);
            report(prog.eval_as(&l, &lang_costs(&cm, &l), Some(&ExBudget::default())));
        }
        _ => eprintln!("unknown mode"),
    }
}
