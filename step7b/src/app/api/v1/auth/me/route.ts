import { errorResponse, jsonOk, requireUser } from "@/server/http";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return jsonOk({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } });
  } catch (error) {
    return errorResponse(error);
  }
}
