use crate::handlers::sign_tx::TxContext;
use crate::AppSW;
use ledger_device_sdk::io::{Command, CommandResponse};
use ledger_device_sdk::nbgl::NbglChoice;

/// Asks the user to approve a ping. Replies 0x01 if approved, 0x00 if rejected.
pub fn handler_ping<'a>(
    command: Command<'a>,
    ctx: &mut TxContext,
) -> Result<CommandResponse<'a>, AppSW> {
    let comm = command.into_comm();
    let approved = NbglChoice::new().show(
        comm,
        "Ping from laptop?",
        "",
        "Approve",
        "Reject",
    );
    ctx.home.show_and_return();

    let mut response = comm.begin_response();
    response.append(&[approved as u8])?;
    Ok(response)
}
