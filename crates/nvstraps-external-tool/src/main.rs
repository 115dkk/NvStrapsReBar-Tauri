use nvstraps_external::*;
use nvstraps_external_tool::*;
use std::path::Path;
fn run() -> Result<(), String> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    match a.first().map(String::as_str){
        Some("inspect")if a.len()==2=>{let s=read_snapshot(Path::new(&a[1]))?;println!("{}",serde_json::to_string_pretty(&s).map_err(|e|e.to_string())?);},
        Some("plan")if a.len()==11=>{
            let s=read_snapshot(Path::new(&a[1]))?;
            let parse=|i:usize|a[i].parse::<u64>().map_err(|_|format!("invalid integer: {}",a[i]));
            let target=Slot{segment:parse(2)?.try_into().map_err(|_|"segment overflow")?,bus:parse(3)?.try_into().map_err(|_|"bus overflow")?,device:parse(4)?.try_into().map_err(|_|"device overflow")?,function:parse(5)?.try_into().map_err(|_|"function overflow")?};
            let next=read_bounded(Path::new(&a[8]),32*1024*1024)?;validate_application(&next)?;
            let size=parse(6)?.checked_mul(1024*1024).ok_or("size overflow")?;
            if a[9]!="--cold-boot-experimental"{return Err("explicit --cold-boot-experimental is required".into());}
            let p=make_plan(&s,target,size,Handoff{path:a[7].clone(),sha256:digest(&next)}).map_err(|e|format!("no external plan: {e:?}"))?;
            write_immutable(Path::new(&a[10]),&serde_json::to_vec_pretty(&p).map_err(|e|e.to_string())?)?;
            println!("planned BAR1 {:#x}..{:#x}; environment={:?}",p.destination.start,p.destination.end,s.environment);
        },
        Some("package")if a.len()==5=>{let p=read_plan(Path::new(&a[3]))?;let receipt=package(Path::new(&a[1]),Path::new(&a[2]),&p,Path::new(&a[4]))?;println!("{receipt}");},
        Some("inject")if a.len()==4=>inject(Path::new(&a[1]),Path::new(&a[2]),Path::new(&a[3]))?,
        _=>return Err("usage: nvstraps-external-tool inspect <diagnostic.json> | plan <diagnostic.json> <segment> <bus> <device> <function> <MiB> <UEFI-next-path> <next.efi> --cold-boot-experimental <plan.json> | package <diagnostic.efi> <loader.efi> <plan.json> <new-output-dir> | inject <source.fd> <driver.ffs> <new-output.fd>".into())
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("nvstraps-external-tool: {e}");
        std::process::exit(1);
    }
}
