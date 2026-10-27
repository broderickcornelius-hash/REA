import { describe, expect, it } from "vitest";

import {
  LATER_BULK_ROWS,
  LATER_FIELD_ROWS,
  OMITTED_FLAG_ROWS,
  SOFT_DELETED_ANSWER_ROWS,
  SOFT_DELETED_QUERY_ROWS,
  SOFT_DELETED_ROWS,
  STALE_DELETE_ANSWER_ROWS,
  STALE_BULK_DELETE_ROWS,
} from "../../../tests/fixtures/environmentStateLaterReads.js";
import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";
import type { JsonValue } from "../../domain/jsonValue.js";

const names = (body: JsonValue | undefined): JsonValue[] => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Expected an object body");
  const list = body["list"];
  if (!Array.isArray(list)) throw new Error("Expected a list");
  return list.map((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? (item["name"] ?? null)
      : null,
  );
};

describe("served writes modelled on later reads", () => {
  it("removes a soft-deleted contact from the served state", () => {
    const contacts = servedFrom(SOFT_DELETED_ROWS);
    contacts.answer("delete_contacts_by_id", { id: "1" });
    expect(names(contacts.answer("get_contacts").body)).toEqual([
      "Mina Okafor",
      "Rui Castellanos",
    ]);
  });

  it("reads a served-deleted contact back marked deleted, as the application answers", () => {
    const contacts = servedFrom(SOFT_DELETED_ROWS);
    contacts.answer("delete_contacts_by_id", { id: "1" });
    expect(contacts.answer("get_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: true,
    });
    // The read finds only what a served delete kept: a reset starts again without it.
    contacts.store.reset();
    expect(contacts.answer("get_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: false,
    });
    // A removal that keeps nothing, as a delete of a type that hard-deletes is, leaves no read.
    contacts.store.removeAll(contacts.store.startedWith("/api/contacts"));
    expect(contacts.refusal("get_contacts_by_id", { id: "1" })).toMatchObject({
      code: expect.any(String),
    });
  });

  it("reads a served-deleted contact back marked deleted when only reads with a query showed one", () => {
    const contacts = servedFrom(SOFT_DELETED_QUERY_ROWS);
    contacts.answer("delete_contacts_by_id", { id: "1" });
    expect(contacts.answer("get_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: true,
    });
  });

  it("answers an update of an initial entity without the field only created entities show", () => {
    const tasks = servedFrom(LATER_FIELD_ROWS);
    const body = tasks.answer("patch_tasks_by_id", {
      id: "1",
      body: { done: true },
    }).body;
    expect(body).toEqual({ id: 1, title: "Trim the wicks", done: true });
  });

  it("answers a bulk update of an initial entity without the field only created entities show", () => {
    const tasks = servedFrom(LATER_BULK_ROWS);
    const body = tasks.answer("patch_tasks", {
      body: [{ id: 1, done: true }],
    }).body;
    expect(body).toEqual([{ id: 1, title: "Trim the wicks", done: true }]);
  });

  it("answers a soft delete with the record marked deleted, as the application does", () => {
    const contacts = servedFrom(SOFT_DELETED_ANSWER_ROWS);
    expect(contacts.answer("delete_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: true,
    });
  });

  it("answers a soft delete with the flag its recorded answer showed, and reads the record back marked deleted", () => {
    const contacts = servedFrom(STALE_DELETE_ANSWER_ROWS);
    expect(contacts.answer("delete_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: false,
    });
    expect(contacts.answer("get_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: true,
    });
  });

  it("answers a soft bulk delete with the flag its recorded answer showed", () => {
    const contacts = servedFrom(STALE_BULK_DELETE_ROWS);
    expect(
      contacts.answer("delete_contacts", { body: [{ id: 1 }] }).body,
    ).toEqual([{ id: 1, name: "Ada Finch", deleted: false }]);
  });

  it("reads a soft-deleted record back marked deleted when live records omit the flag", () => {
    const contacts = servedFrom(OMITTED_FLAG_ROWS);
    contacts.answer("delete_contacts_by_id", { id: "1" });
    expect(contacts.answer("get_contacts_by_id", { id: "1" }).body).toEqual({
      id: 1,
      name: "Ada Finch",
      deleted: true,
    });
  });
});
