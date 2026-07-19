package com.example.anymovieonline

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide

class TvMediaAdapter(
    private val onClick: (TvMediaItem) -> Unit
) : RecyclerView.Adapter<TvMediaAdapter.MediaViewHolder>() {

    private val items = mutableListOf<TvMediaItem>()

    fun submitList(next: List<TvMediaItem>) {
        items.clear()
        items.addAll(next)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MediaViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_media_card, parent, false)
        return MediaViewHolder(view, onClick)
    }

    override fun onBindViewHolder(holder: MediaViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    class MediaViewHolder(
        view: View,
        private val onClick: (TvMediaItem) -> Unit
    ) : RecyclerView.ViewHolder(view) {
        private val cover: ImageView = view.findViewById(R.id.coverImage)
        private val title: TextView = view.findViewById(R.id.titleText)
        private val subtitle: TextView = view.findViewById(R.id.subtitleText)
        private val badge: TextView = view.findViewById(R.id.badgeText)

        fun bind(item: TvMediaItem) {
            title.text = item.title
            subtitle.text = item.subtitle.ifBlank { if (item.contentType == "series") "TV" else "Movie" }
            badge.text = when {
                item.inLibrary -> "LOCAL"
                item.contentType == "series" -> "TV"
                else -> "MOVIE"
            }

            val coverUrl = item.coverUrl
            if (coverUrl.isNotBlank()) {
                Glide.with(cover.context)
                    .load(coverUrl)
                    .centerCrop()
                    .placeholder(R.drawable.default_background)
                    .into(cover)
            } else {
                cover.setImageResource(R.drawable.default_background)
            }

            itemView.setOnClickListener { onClick(item) }
        }
    }
}
