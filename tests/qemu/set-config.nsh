@echo -off
dmpstore -guid e3ee4a27-e2a2-4435-bba3-184ccad935a8 NvStrapsReBarStatus
setvar NvStrapsReBar -guid e3ee4a27-e2a2-4435-bba3-184ccad935a8 -bs -rt -nv =H0120000000000000000000000000
dmpstore -guid e3ee4a27-e2a2-4435-bba3-184ccad935a8 NvStrapsReBar
reset -s
