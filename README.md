# Opportunity Hunter OMS

A Chrome extension for managing opportunities through threads. A thread can have a single point of contact (SPOC), which you can assign later. It works offline and stores CRM data only in the local Chrome profile.

Current version: **1.2**

Versioning rule: major upgrades change the whole number, such as `2.0`; minor changes change the decimal, such as `1.1`.

## Install

1. Open Chrome and visit `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked** and choose this folder.
4. Pin **Opportunity Hunter OMS** to the toolbar, then click its icon to open the side panel.

No build step, account, internet connection, or third-party service is required after the extension files are available locally.

Use the arrow icon at the top right of the side panel to open the CRM in a full Chrome tab. Both views use the same local data.

## Use

Create an opportunity and assign it a category. The **Opportunities** view starts with category folders; expand a folder to see its opportunities and their threads beneath them. Existing opportunities without a category appear in **Uncategorized**. A thread can be created without a SPOC and assigned one later. You can create a person while adding or editing the thread, add a description, save useful links, upload images, paste images from the clipboard, set its next follow-up date, and add updates such as conversations, commitments, insights, and next steps. The **Follow-ups** tab shows dated open threads across opportunities.

## Backup and restore

Open the menu (**⋯**) in the side panel and choose **Download backup**. This downloads one JSON file containing all categories assigned to opportunities, opportunities, people, threads, thread descriptions, saved links, attached images, updates, and follow-up dates. Keep this file outside Chrome. Use **Choose backup file** in the same menu to restore it later, including in a fresh installation. Restore replaces the current local CRM after confirmation.

Backups are plain JSON and are not encrypted. Store them accordingly. Images are embedded into the backup, so large images can make the backup file larger. The current version does not support external message syncing or cross-device merging.

Chrome removes an extension's local data when the extension is uninstalled. A downloaded backup is required to recover it afterward.
